"""movies.sample_movie_url をバックフィルするジョブ。

背景:
    sync_catalog.py は `sample_movie_url=None` で保存し、解決はユーザー初回
    再生時に動的に行う設計だが、初回アクセスごとに DMM への 2 リクエスト分
    のレイテンシが発生する。

    このジョブは `sample_movie_url IS NULL` の movies を対象に、apps/api と
    同じ ``app.resolver.extractor.extract_mp4_url`` (in-process httpx) で
    MP4 URL を並列抽出して DB に書き戻す。

    かつては Xserver VPS 上の resolver サービスを HTTP で叩いていたが、
    resolver コンテナを廃止して in-process 抽出に統一した。

実行要件:
    - DATABASE_URL 環境変数
    - DMM_AFFILIATE_ID 環境変数
    - RESOLVER_TIMEOUT_SEC 環境変数 (任意、デフォルト 10)

使い方:
    # NULL の movies を全部処理 (並列度 4)
    python -m src.resolve_sample_urls --concurrency 4

    # 上限指定 (テスト用)
    python -m src.resolve_sample_urls --limit 100

    # DB に書き込まずログ出力だけ
    python -m src.resolve_sample_urls --dry-run --limit 10

    # 既存解決済みも含めて全件再解決 (月次フルリフレッシュ用)
    python -m src.resolve_sample_urls --force-all
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time
from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

# 直接モデル定義に依存せず、テーブルを最小限触る。
# apps/api の Movie モデル・extractor を再利用するために sys.path を調整する。
_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(_REPO_ROOT, "apps", "api"))
from app.db.models.movie import Movie  # noqa: E402
from app.resolver.extractor import (  # noqa: E402
    ResolveNotFound,
    ResolveTimeout,
    ResolveUpstream,
    extract_mp4_url,
)

logger = logging.getLogger(__name__)


def _get_async_url(url: str) -> str:
    """postgresql://... を asyncpg ドライバ用に変換する。"""
    if url.startswith("postgresql://"):
        return "postgresql+asyncpg://" + url[len("postgresql://"):]
    return url


@dataclass
class ResolveCounters:
    total: int = 0
    success: int = 0
    not_found: int = 0
    timeout: int = 0
    upstream_error: int = 0
    other_error: int = 0

    def summary(self) -> str:
        return (
            f"total={self.total} success={self.success} "
            f"not_found={self.not_found} timeout={self.timeout} "
            f"upstream_error={self.upstream_error} other_error={self.other_error}"
        )


async def _call_extractor(
    content_id: str,
    affiliate_id: str,
    timeout_sec: float,
) -> tuple[str | None, str | None]:
    """extractor を呼んで (mp4_url, error_kind) を返す。"""
    try:
        result = await extract_mp4_url(
            content_id=content_id,
            affiliate_id=affiliate_id,
            timeout_s=timeout_sec,
        )
    except ResolveTimeout:
        return None, "timeout"
    except ResolveNotFound:
        return None, "not_found"
    except ResolveUpstream as e:
        logger.warning("upstream error for %s: %s", content_id, e)
        return None, "upstream_error"
    except Exception as e:  # pylint: disable=broad-except
        logger.warning("unexpected error for %s: %s", content_id, e)
        return None, "other_error"
    return result.mp4_url, None


async def _process_one(
    sem: asyncio.Semaphore,
    Session,
    affiliate_id: str,
    timeout_sec: float,
    movie_id: str,
    content_id: str,
    slug: str,
    dry_run: bool,
    counters: ResolveCounters,
) -> None:
    async with sem:
        t0 = time.monotonic()
        mp4, err = await _call_extractor(content_id, affiliate_id, timeout_sec)
        elapsed = time.monotonic() - t0

        if err is not None:
            setattr(counters, err, getattr(counters, err) + 1)
            logger.warning(
                "[%s] FAIL err=%s elapsed=%.1fs slug=%s cid=%s",
                err, err, elapsed, slug, content_id,
            )
            return

        assert mp4 is not None
        counters.success += 1
        logger.info(
            "[ok] elapsed=%.1fs slug=%s cid=%s url=%s",
            elapsed, slug, content_id, mp4[:80],
        )

        if dry_run:
            return

        # DB 書き戻し
        async with Session() as session:
            await session.execute(
                update(Movie)
                .where(Movie.id == movie_id)
                .where(Movie.sample_movie_url.is_distinct_from(mp4))
                .values(sample_movie_url=mp4)
            )
            await session.commit()


async def main(
    *,
    concurrency: int,
    limit: int | None,
    dry_run: bool,
    force_all: bool = False,
) -> None:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL が設定されていません")
    affiliate_id = os.getenv("DMM_AFFILIATE_ID", "").strip()
    if not affiliate_id:
        raise SystemExit("DMM_AFFILIATE_ID が設定されていません")
    timeout_sec = float(os.getenv("RESOLVER_TIMEOUT_SEC", "10"))

    print(
        f"[resolve_sample_urls] start concurrency={concurrency} "
        f"limit={limit} dry_run={dry_run} force_all={force_all}"
    )

    engine = create_async_engine(_get_async_url(db_url))
    Session = async_sessionmaker(engine, expire_on_commit=False)

    # 対象 movies を取得。
    # 通常モード: sample_movie_url IS NULL のものだけ (差分埋め)
    # force_all=True: content_id を持つすべての movies を再解決
    #   (CDN 側の URL が定期的に切り替わるため、月次フルリフレッシュで使う)
    async with Session() as session:
        stmt = select(
            Movie.id, Movie.content_id, Movie.slug
        ).where(
            Movie.content_id.is_not(None),
        )
        if not force_all:
            stmt = stmt.where(Movie.sample_movie_url.is_(None))
        rows = (await session.execute(stmt)).all()

    targets: list[tuple[str, str, str]] = [
        (movie_id, content_id, slug)
        for movie_id, content_id, slug in rows
        if content_id
    ]

    if limit is not None:
        targets = targets[:limit]

    counters = ResolveCounters(total=len(targets))
    print(f"[resolve_sample_urls] targets={len(targets)}")

    if not targets:
        await engine.dispose()
        print("[resolve_sample_urls] nothing to do")
        return

    # extractor を並列に呼ぶ
    sem = asyncio.Semaphore(concurrency)
    await asyncio.gather(*[
        _process_one(
            sem, Session, affiliate_id, timeout_sec,
            movie_id, content_id, slug, dry_run, counters,
        )
        for movie_id, content_id, slug in targets
    ])

    await engine.dispose()
    print(f"[resolve_sample_urls] done: {counters.summary()}")


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--concurrency", type=int, default=4,
        help="同時並列数 (デフォルト 4)",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="対象件数の上限。指定なしで全件。テスト時に使う。",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="DB 書き込みせずログ出力だけ",
    )
    parser.add_argument(
        "--force-all", action="store_true",
        help=(
            "解決済み (sample_movie_url IS NOT NULL) も含めて全件再解決する。"
            "CDN URL の期限切れに備えた月次フルリフレッシュ用。"
        ),
    )
    args = parser.parse_args()

    asyncio.run(main(
        concurrency=args.concurrency,
        limit=args.limit,
        dry_run=args.dry_run,
        force_all=args.force_all,
    ))
