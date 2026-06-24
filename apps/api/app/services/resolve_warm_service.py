"""候補動画の MP4 URL を事前 resolve して成功キャッシュを温めるサービス。

設計意図:
    フィードの初回再生待ち (resolve-mp4 の DMM 実アクセス ~数秒) を体感から消すため、
    バックグラウンドで人気作の low/high mp4_url を先に解決して `resolver_client` の
    成功キャッシュ (Redis があれば `resolver:mp4:<content_id>`、無ければ API プロセス
    の in-process LRU) に載せておく。

    DB には MP4 URL を保存しない方針 (apps/api/app/db/models/movie.py 参照) を維持し、
    保存先は既存 resolver と同じキャッシュ層に限定する。これによりトークン期限管理を
    resolver_client の TTL に一元化できる。

起動方法は 2 通り:
    1. API プロセス内 (推奨 / Redis 不要):
       `RESOLVE_WARM_ENABLED=true` のとき main.py の lifespan が
       `warm_resolve_loop()` を常駐起動する。フィードを返すのと同じプロセスの
       in-process キャッシュを温めるため、Redis が無い単一プロセス構成でも効く。
    2. 単発 CLI (Redis 共有時 / 手動運用):
       `python -m app.services.resolve_warm_service --limit 500 --concurrency 4`。
       1 発実行して終わるため、温め先が in-process だけだと終了時に失われる点に注意
       (Redis 共有環境や手動デバッグ向け)。

    いずれも resolver の in-flight dedupe を活かしつつ同時実行数を絞り、DMM への
    バースト (429/504) を避ける。DMM_AFFILIATE_ID 未設定なら安全に no-op になる。
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os

from app.core.cache import close_redis
from app.db.session import AsyncSessionLocal
from app.repositories.movie_repository import get_resolve_warm_content_ids
from app.services import resolver_client

logger = logging.getLogger(__name__)

# 同時に DMM を叩く本数。resolver_client 側の in-flight dedupe と合わせて、
# 上流 (DMM / Cloudflare) のバースト 429/504 を避けるため控えめに固定する。
DEFAULT_CONCURRENCY = 4
# 1 回の job で温める上限件数。フィード初回で当たりやすい人気上位だけを対象にする。
DEFAULT_LIMIT = 500


async def warm_resolve_cache(
    *,
    limit: int = DEFAULT_LIMIT,
    concurrency: int = DEFAULT_CONCURRENCY,
    bypass_cache: bool = False,
) -> tuple[int, int]:
    """人気上位 `limit` 件の MP4 URL を事前 resolve する。

    Args:
        limit: 温める最大件数 (review_count desc 上位)。
        concurrency: 同時 resolve 本数。
        bypass_cache: True なら既存の成功キャッシュを無視して必ず再抽出する
            (トークンを能動的にローテーションしたい cron 用)。

    Returns:
        (成功件数, 試行件数)。
    """
    async with AsyncSessionLocal() as db:
        content_ids = await get_resolve_warm_content_ids(db, limit=limit)

    total = len(content_ids)
    if total == 0:
        logger.info("[resolve_warm] no content_ids to warm")
        return 0, 0

    semaphore = asyncio.Semaphore(max(1, concurrency))
    success = 0
    config_error = False

    async def warm_one(content_id: str) -> None:
        nonlocal success, config_error
        async with semaphore:
            # DMM 未設定が一度でも分かったら、以降の content_id は試さない
            # (全件同じ失敗になるため。空振りの httpx ラウンドトリップを避ける)。
            if config_error:
                return
            try:
                await resolver_client.resolve_mp4(
                    content_id, bypass_cache=bypass_cache
                )
            except resolver_client.ResolverConfigError:
                config_error = True
                return
            except Exception:  # noqa: BLE001
                logger.debug(
                    "[resolve_warm] failed content_id=%s", content_id, exc_info=True
                )
                return
            success += 1

    # return_exceptions=True で 1 件の失敗が他タスクを orphan 化しない
    # (long-running な warm ループから呼ばれるため「Task exception was never
    # retrieved」警告を出さないようにする)。ResolverConfigError は warm_one 内で
    # フラグ化して以降をスキップする。
    await asyncio.gather(
        *(warm_one(cid) for cid in content_ids), return_exceptions=True
    )

    if config_error:
        logger.error(
            "[resolve_warm] DMM_AFFILIATE_ID is not configured; aborting warm job"
        )
        # 呼び出し側 (CLI / loop) が「設定不備」を検知できるよう従来通り送出する。
        raise resolver_client.ResolverConfigError(
            "DMM_AFFILIATE_ID is not configured"
        )

    logger.info("[resolve_warm] warmed %d/%d content_ids", success, total)
    return success, total


async def warm_resolve_loop(
    *,
    interval_s: int,
    limit: int,
    concurrency: int,
    stop_event: asyncio.Event,
) -> None:
    """API プロセス内で回す常駐 warm ループ。

    起動直後に 1 回 warm し、その後 `interval_s` ごとに繰り返す。`stop_event`
    がセットされたら次の sleep を待たずに抜ける (lifespan shutdown 用)。

    フィードを返すのと同じプロセスで動くため、Redis が無い構成でも
    resolver_client の in-process 成功キャッシュを直接温められる
    (= 初回再生の resolve 待ちが減る)。例外は握り潰してループを止めない。
    """
    while not stop_event.is_set():
        try:
            success, total = await warm_resolve_cache(
                limit=limit,
                concurrency=concurrency,
            )
            logger.info(
                "[resolve_warm] loop warmed %d/%d (next in %ds)",
                success,
                total,
                interval_s,
            )
        except resolver_client.ResolverConfigError:
            # DMM 未設定環境ではループ自体を畳む (温められないため)。
            logger.info(
                "[resolve_warm] DMM_AFFILIATE_ID not configured; stopping warm loop"
            )
            return
        except Exception:  # noqa: BLE001
            logger.warning("[resolve_warm] loop iteration failed", exc_info=True)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_s)
        except asyncio.TimeoutError:
            pass


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(1, value)


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


async def _run_cli(
    *,
    limit: int,
    concurrency: int,
    bypass_cache: bool,
) -> tuple[int, int]:
    """CLI 用エントリ。warm したあと、このプロセス専用に確保した共有リソース
    (resolver の httpx.AsyncClient / Redis 接続) を必ず閉じてから返す。

    `warm_resolve_cache` 自体は API プロセスからも呼べるよう副作用を持たせない。
    共有 client / Redis はイベントループに紐づくため、`asyncio.run` がループを
    閉じる前 (= この async 内) で片付ける必要がある。
    """
    try:
        return await warm_resolve_cache(
            limit=limit,
            concurrency=concurrency,
            bypass_cache=bypass_cache,
        )
    except resolver_client.ResolverConfigError:
        # DMM 未設定。warm_resolve_cache 側でログ済みなので、CLI は traceback では
        # なく (0, 0) を返して静かに終わる。
        return 0, 0
    finally:
        try:
            await resolver_client.shutdown_resolver_http_client()
        except Exception:  # noqa: BLE001
            logger.debug("[resolve_warm] resolver http client close failed", exc_info=True)
        try:
            await close_redis()
        except Exception:  # noqa: BLE001
            logger.debug("[resolve_warm] redis close failed", exc_info=True)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    parser = argparse.ArgumentParser(
        description="候補動画の MP4 URL を事前 resolve して Redis を温める"
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=_env_int("RESOLVE_WARM_LIMIT", DEFAULT_LIMIT),
        help="温める最大件数 (review_count desc 上位)",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=_env_int("RESOLVE_WARM_CONCURRENCY", DEFAULT_CONCURRENCY),
        help="同時 resolve 本数",
    )
    parser.add_argument(
        "--bypass-cache",
        action="store_true",
        default=_env_bool("RESOLVE_WARM_BYPASS_CACHE", False),
        help="既存の成功キャッシュを無視して必ず再抽出する",
    )
    args = parser.parse_args()

    success, total = asyncio.run(
        _run_cli(
            limit=max(1, args.limit),
            concurrency=max(1, args.concurrency),
            bypass_cache=args.bypass_cache,
        )
    )
    logger.info("[resolve_warm] done: %d/%d", success, total)


if __name__ == "__main__":
    main()
