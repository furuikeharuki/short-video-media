"""resolver サービスを HTTP で叩いて movies.sample_movie_url をバックフィルするジョブ。

背景:
    sync_catalog.py は DMM Affiliate API が返す `sampleMovieURL` の生値を DB に
    保存していたが、それは litevideo iframe (HTML) や旧形式の `_mhb_w.mp4` で、
    Chromium の Opaque Response Blocking や 404 で再生できない。
    PR #39 以降、sync_catalog は `sample_movie_url=None` で保存し、resolver が
    ユーザー初回再生時に動的に解決する設計に切り替わったが、初回アクセスのたびに
    9 秒待ち (resolver の Playwright 実行) が発生してしまう。

    このジョブは `sample_movie_url IS NULL` の movies を対象に、Xserver VPS Tokyo の
    resolver サービスを HTTP で並列に叩き、再生可能な MP4 URL を取得して DB に
    書き戻すことでユーザー体験を先回りで改善する。

実行要件:
    - DATABASE_URL 環境変数
    - RESOLVER_BASE_URL 環境変数 (e.g. http://162.43.24.128)
    - RESOLVER_API_KEY 環境変数 (Bearer 認証)
    - RESOLVER_TIMEOUT_SEC 環境変数 (任意、デフォルト 60)

使い方:
    # NULL の movies を全部処理 (並列度 4)
    python -m src.resolve_sample_urls --concurrency 4

    # 上限指定 (テスト用)
    python -m src.resolve_sample_urls --limit 100

    # 旧形式 (_mhb_w / _dm_w) も対象にする (ガード強化)
    python -m src.resolve_sample_urls --include-legacy

    # DB に書き込まずログ出力だけ
    python -m src.resolve_sample_urls --dry-run --limit 10
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time
from dataclasses import dataclass

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

# 直接モデル定義に依存せず、テーブルを最小限触る。
# apps/api の Movie モデルを再利用するために sys.path を調整する。
_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(_REPO_ROOT, "apps", "api"))
from app.db.models.movie import Movie  # noqa: E402

logger = logging.getLogger(__name__)

# 旧形式の URL パターン。--include-legacy で対象に加える。
# (apps/api/app/api/v1/endpoints/movies.py の同名定数とそろえる)
import re  # noqa: E402

LEGACY_PATTERN = re.compile(r"_(mhb|dm)_w\.mp4(\?|$)", re.IGNORECASE)


def _is_legacy(url: str | None) -> bool:
    if not url:
        return False
    return LEGACY_PATTERN.search(url) is not None


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
    unavailable: int = 0
    other_error: int = 0

    def summary(self) -> str:
        return (
            f"total={self.total} success={self.success} "
            f"not_found={self.not_found} timeout={self.timeout} "
            f"upstream_error={self.upstream_error} unavailable={self.unavailable} "
            f"other_error={self.other_error}"
        )


async def _call_resolver(
    client: httpx.AsyncClient,
    base_url: str,
    api_key: str,
    content_id: str,
    timeout_sec: float,
) -> tuple[str | None, str | None]:
    """resolver を叩いて (mp4_url, error_kind) を返す。"""
    url = f"{base_url.rstrip('/')}/resolve"
    try:
        res = await client.post(
            url,
            json={"content_id": content_id},
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout_sec,
        )
    except httpx.TimeoutException:
        return None, "timeout"
    except httpx.HTTPError as e:
        logger.warning("resolver HTTP error for %s: %s", content_id, e)
        return None, "unavailable"

    if res.status_code == 404:
        return None, "not_found"
    if res.status_code >= 500:
        return None, "upstream_error"
    if res.status_code != 200:
        return None, "other_error"

    try:
        body = res.json()
    except Exception:
        return None, "other_error"

    mp4 = body.get("mp4_url") or body.get("url") or None
    if not mp4:
        return None, "other_error"
    return mp4, None


async def _process_one(
    sem: asyncio.Semaphore,
    client: httpx.AsyncClient,
    Session,
    base_url: str,
    api_key: str,
    timeout_sec: float,
    movie_id: str,
    content_id: str,
    slug: str,
    dry_run: bool,
    counters: ResolveCounters,
) -> None:
    async with sem:
        t0 = time.monotonic()
        mp4, err = await _call_resolver(
            client, base_url, api_key, content_id, timeout_sec
        )
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
    include_legacy: bool,
    dry_run: bool,
) -> None:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL が設定されていません")
    base_url = os.getenv("RESOLVER_BASE_URL")
    if not base_url:
        raise SystemExit("RESOLVER_BASE_URL が設定されていません")
    api_key = os.getenv("RESOLVER_API_KEY")
    if not api_key:
        raise SystemExit("RESOLVER_API_KEY が設定されていません")
    timeout_sec = float(os.getenv("RESOLVER_TIMEOUT_SEC", "60"))

    print(
        f"[resolve_sample_urls] start concurrency={concurrency} "
        f"limit={limit} include_legacy={include_legacy} dry_run={dry_run}"
    )

    engine = create_async_engine(_get_async_url(db_url))
    Session = async_sessionmaker(engine, expire_on_commit=False)

    # 対象 movies を取得
    async with Session() as session:
        stmt = select(
            Movie.id, Movie.content_id, Movie.slug, Movie.sample_movie_url
        ).where(Movie.content_id.is_not(None))
        rows = (await session.execute(stmt)).all()

    targets: list[tuple[str, str, str]] = []
    for movie_id, content_id, slug, sample_url in rows:
        if not content_id:
            continue
        if sample_url is None:
            targets.append((movie_id, content_id, slug))
        elif include_legacy and _is_legacy(sample_url):
            targets.append((movie_id, content_id, slug))

    if limit is not None:
        targets = targets[:limit]

    counters = ResolveCounters(total=len(targets))
    print(f"[resolve_sample_urls] targets={len(targets)}")

    if not targets:
        await engine.dispose()
        print("[resolve_sample_urls] nothing to do")
        return

    # resolver を並列に叩く
    sem = asyncio.Semaphore(concurrency)
    async with httpx.AsyncClient() as client:
        await asyncio.gather(*[
            _process_one(
                sem, client, Session, base_url, api_key, timeout_sec,
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
        help="同時並列数 (デフォルト 4、VPS resolver の RESOLVER_CONCURRENCY=8 に合わせる)",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="対象件数の上限。指定なしで全件。テスト時に使う。",
    )
    parser.add_argument(
        "--include-legacy", action="store_true",
        help="sample_movie_url が旧形式 (_mhb_w / _dm_w) のレコードも対象にする",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="DB 書き込みせずログ出力だけ",
    )
    args = parser.parse_args()

    asyncio.run(main(
        concurrency=args.concurrency,
        limit=args.limit,
        include_legacy=args.include_legacy,
        dry_run=args.dry_run,
    ))
