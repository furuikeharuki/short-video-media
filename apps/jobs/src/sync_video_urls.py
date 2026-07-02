"""サンプル動画 MP4 URL を DB に事前保存する定期バッチ (月 1 実行想定)。

背景 / 目的:
  - サンプル動画の MP4 直リンク (DMM の署名付き URL) は、以前は「トークン期限切れ」
    を嫌って DB に保存せず、再生のたびに resolver で都度抽出していた。
  - しかし毎回の抽出は高画質再生までのレイテンシが大きい。そこで
    「低画質・高画質ともに DB に保存し、再生時は DB 値を返す。無い/再生不可の
    ときだけ都度抽出して DB を更新する」方式に変更した (movies.sample_*_mp4_url)。
  - 本ジョブはその DB キャッシュを事前に埋める / 貼り直すためのもの。
    DMM トークンは 32 日以上有効なので、月 1 で貼り直せば期限切れは実質起きない。

対象:
  - is_visible=True かつ content_id を持つ作品。
  - 既定 (--only-missing) では、まだ URL を保存していない作品だけを対象にする
    (差分実行 / 初回バックフィル)。
  - --force / --no-only-missing で全作品を対象に貼り直す (月次フルリフレッシュ)。

実行方法:
  cd apps/jobs
  python -m src.sync_video_urls                 # URL 未保存の作品を埋める (差分)
  python -m src.sync_video_urls --force         # 全作品を再抽出して貼り直す (月次)
  python -m src.sync_video_urls --limit 500     # 先頭 500 件だけ
  python -m src.sync_video_urls --dry-run       # DB に書かずログだけ

環境変数 (CLI 未指定時のフォールバック):
  - DMM_AFFILIATE_ID              : resolver が DMM を叩くのに必須
  - DATABASE_URL                  : 保存先 DB
  - SYNC_VIDEO_URLS_LIMIT         : int, 処理上限件数
  - SYNC_VIDEO_URLS_ONLY_MISSING  : bool, 既定 true (未保存のみ)
  - SYNC_VIDEO_URLS_FORCE         : bool, true で全件貼り直し (only_missing を無効化)
  - SYNC_VIDEO_URLS_DRY_RUN       : bool, true で書き込みなし
  - SYNC_VIDEO_URLS_CONCURRENCY   : int, 同時抽出数 (既定 3; DMM 負荷を抑える)
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine

# apps/api を import パスに追加 (モデル / resolver / service を共有するため)
_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT / "apps" / "api"))

from app.repositories.movie_repository import (  # noqa: E402
    get_movie_video_url_targets,
)
from app.services import movie_video_url_service, resolver_client  # noqa: E402

from src.advisory_lock import advisory_lock  # noqa: E402
from src.sync_catalog import _build_sessionmaker  # noqa: E402


# 同時に走らせる resolver 抽出の既定数。DMM 側へ過剰なバーストを掛けないよう低めに。
DEFAULT_CONCURRENCY = 3
# 1 チャンクで処理する件数。抽出は並列だが、DB 書き込みは単一セッションで
# 直列化する (AsyncSession は同時操作不可)。全件を一度に gather すると
# 数万件でメモリを食うため、チャンクに割って逐次処理する。
_CHUNK_SIZE = 200


def _get_async_url(url: str) -> str:
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+asyncpg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


@dataclass
class Counters:
    resolved: int = 0
    saved: int = 0
    not_found: int = 0
    errors: int = 0
    skipped: int = 0


async def _resolve_one(
    content_id: str,
    *,
    semaphore: asyncio.Semaphore,
    force: bool,
    counters: Counters,
) -> resolver_client.ResolvedMp4 | None:
    """1 件の content_id を抽出する。失敗時は None を返しカウンタを進める。

    force=True なら resolver の短期成功キャッシュをバイパスして必ず DMM を叩く
    (月次フルリフレッシュでトークンを確実に貼り直すため)。
    ResolverConfigError (DMM_AFFILIATE_ID 未設定等) は全件同じく失敗するので
    呼び出し側で中断させるため送出する。
    """
    async with semaphore:
        try:
            return await resolver_client.resolve_mp4(content_id, bypass_cache=force)
        except resolver_client.ResolverNotFound:
            counters.not_found += 1
            print(f"  [not_found] content_id={content_id}")
            return None
        except resolver_client.ResolverConfigError:
            raise
        except Exception as e:  # noqa: BLE001
            counters.errors += 1
            print(f"  [error] content_id={content_id}: {e}")
            return None


def _chunked(seq: list, size: int):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


async def _process_chunk(
    session,
    chunk: list[tuple[str, str]],
    *,
    semaphore: asyncio.Semaphore,
    force: bool,
    dry_run: bool,
    counters: Counters,
) -> None:
    """1 チャンク分を「並列抽出 → 直列 DB 書き込み」で処理する。

    抽出は semaphore で同時数を絞って並列化するが、DB 書き込みは AsyncSession が
    同時操作をサポートしないため直列で行い、チャンド末尾で 1 回 commit する。
    """
    # 1) 並列抽出 (順序は chunk と対応させる)
    results = await asyncio.gather(
        *(
            _resolve_one(
                content_id, semaphore=semaphore, force=force, counters=counters
            )
            for _movie_id, content_id in chunk
        )
    )

    # 2) 直列 DB 書き込み (単一セッション)。commit はチャンク末尾で 1 回。
    wrote = False
    for (movie_id, content_id), resolved in zip(chunk, results):
        if resolved is None:
            continue
        counters.resolved += 1
        if dry_run:
            counters.skipped += 1
            normalized = movie_video_url_service.normalize_resolved(resolved)
            print(
                f"  [dry-run] movie_id={movie_id} content_id={content_id} "
                f"low={_short(normalized.low_mp4_url)} "
                f"high={_short(normalized.high_mp4_url)}"
            )
            continue
        # commit=False でまとめて、チャンク末尾で 1 回 commit する。
        await movie_video_url_service.persist_resolved(
            session, movie_id, resolved, commit=False
        )
        counters.saved += 1
        wrote = True

    if wrote:
        try:
            await session.commit()
        except Exception as e:  # noqa: BLE001
            print(f"  [error] chunk commit failed: {e}")
            try:
                await session.rollback()
            except Exception:  # noqa: BLE001
                pass


async def main(
    *,
    limit: int | None,
    only_missing: bool,
    force: bool,
    dry_run: bool,
    concurrency: int,
) -> None:
    if not os.getenv("DMM_AFFILIATE_ID"):
        raise SystemExit("DMM_AFFILIATE_ID が設定されていません")
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL が設定されていません")

    # force=True のときは only_missing を無効化して全件貼り直す。
    effective_only_missing = only_missing and not force

    print(
        f"[sync_video_urls] start: limit={limit} only_missing={effective_only_missing} "
        f"force={force} dry_run={dry_run} concurrency={concurrency}"
    )

    engine = create_async_engine(_get_async_url(db_url))
    Session = _build_sessionmaker(engine)
    counters = Counters()

    try:
        async with advisory_lock("sync_video_urls") as acquired:
            if not acquired:
                print("[sync_video_urls] another instance is running; skip")
                return

            async with Session() as session:
                targets = await get_movie_video_url_targets(
                    session, only_missing=effective_only_missing, limit=limit
                )
                total = len(targets)
                print(f"[sync_video_urls] {total} movies to process")
                if total == 0:
                    return

                semaphore = asyncio.Semaphore(max(1, concurrency))
                processed = 0
                for chunk in _chunked(targets, _CHUNK_SIZE):
                    try:
                        await _process_chunk(
                            session,
                            chunk,
                            semaphore=semaphore,
                            force=force,
                            dry_run=dry_run,
                            counters=counters,
                        )
                    except resolver_client.ResolverConfigError as e:
                        raise SystemExit(
                            f"[sync_video_urls] resolver 設定エラー: {e}"
                        ) from e
                    processed += len(chunk)
                    print(
                        f"[sync_video_urls] progress: {processed}/{total} "
                        f"(saved={counters.saved} not_found={counters.not_found} "
                        f"errors={counters.errors})"
                    )
    finally:
        await engine.dispose()

    print(
        f"[sync_video_urls] done: resolved={counters.resolved} saved={counters.saved} "
        f"not_found={counters.not_found} errors={counters.errors} "
        f"skipped={counters.skipped}"
    )


def _short(url: str | None) -> str:
    """ログ用に URL を短くする (署名クエリを落として basename 程度に)。"""
    if not url:
        return "-"
    base = url.split("?", 1)[0]
    return base.rsplit("/", 1)[-1] or base


def _resolve_cli_args(argv: list[str] | None = None) -> dict:
    """CLI 引数と環境変数から `main()` 用 kwargs を解決する。

    優先順位は CLI > 環境変数 > ハードコード default。
    """
    from src import scheduled_config as cfg

    parser = argparse.ArgumentParser(
        description="サンプル動画 MP4 URL を DB に事前保存する定期バッチ"
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="処理する作品の最大件数 (未指定なら env SYNC_VIDEO_URLS_LIMIT → 全件)",
    )
    parser.add_argument(
        "--only-missing", dest="only_missing", action="store_true", default=None,
        help="URL 未保存の作品だけを対象にする (差分実行)。既定 true。",
    )
    parser.add_argument(
        "--no-only-missing", dest="only_missing", action="store_false",
        help="保存済みも含めて全対象を処理する",
    )
    parser.add_argument(
        "--force", action="store_true",
        help=(
            "resolver の短期キャッシュをバイパスして全作品を再抽出・貼り直す "
            "(月次フルリフレッシュ; only_missing を無効化)。"
            " env SYNC_VIDEO_URLS_FORCE=1 でも有効"
        ),
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="DB に書き込まずログだけ (env SYNC_VIDEO_URLS_DRY_RUN=1 でも有効)",
    )
    parser.add_argument(
        "--concurrency", type=int, default=None,
        help=(
            "同時抽出数 (未指定なら env SYNC_VIDEO_URLS_CONCURRENCY → "
            f"{DEFAULT_CONCURRENCY})"
        ),
    )
    args = parser.parse_args(argv)

    try:
        limit = args.limit
        if limit is None:
            limit = cfg.env_int("SYNC_VIDEO_URLS_LIMIT", minimum=1)

        # only_missing: CLI (True/False/None) → env → 既定 True
        if args.only_missing is None:
            only_missing = cfg.env_bool("SYNC_VIDEO_URLS_ONLY_MISSING", default=True)
        else:
            only_missing = bool(args.only_missing)

        force = bool(args.force) or cfg.env_bool(
            "SYNC_VIDEO_URLS_FORCE", default=False
        )
        dry_run = bool(args.dry_run) or cfg.env_bool(
            "SYNC_VIDEO_URLS_DRY_RUN", default=False
        )

        concurrency = args.concurrency
        if concurrency is None:
            concurrency = cfg.env_int("SYNC_VIDEO_URLS_CONCURRENCY", minimum=1)
        if concurrency is None:
            concurrency = DEFAULT_CONCURRENCY
    except cfg.EnvConfigError as e:
        raise SystemExit(f"[sync_video_urls] 設定エラー: {e}") from e

    print(
        f"[sync_video_urls] resolved config: limit={limit} only_missing={only_missing} "
        f"force={force} dry_run={dry_run} concurrency={concurrency}"
    )
    return dict(
        limit=limit,
        only_missing=only_missing,
        force=force,
        dry_run=dry_run,
        concurrency=concurrency,
    )


if __name__ == "__main__":
    asyncio.run(main(**_resolve_cli_args()))
