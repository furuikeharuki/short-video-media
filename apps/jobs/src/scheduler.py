"""Railway 内 jobs-worker サービスの常駐エントリポイント。

Postgres へは Railway Private Network 経由 (`postgres.railway.internal:5432`) で
接続するため、SELECT / RETURNING の応答が Public Network egress として
カウントされない。これにより GitHub Actions cron 経由で発生していた
egress 大量課金 ($61/2日 など) を完全にゼロ化することが目的。

スケジュール (JST 想定):
  - sync_catalog (incremental)        : 2 時間ごと (08, 10, 12, 14, 16, 18, 20 JST)
  - resolve_sample_urls               : 毎日 03:00 JST
  - sync_actress_profiles (--only-missing) : 毎日 04:00 JST

タイムゾーン:
  - APScheduler の cron は TZ を Asia/Tokyo 固定で評価する

異常時:
  - 各ジョブは内部で例外を握りつぶしてログ出力するだけ。スケジューラ自体は
    例外で止めない。Railway logs で詳細を追える。

環境変数 (すべて Railway Variables で設定):
  - DATABASE_URL              : postgresql://...@postgres.railway.internal:5432/...
  - DMM_API_ID                : DMM Webservice API ID
  - DMM_AFFILIATE_ID          : DMM API 呼び出し用 (-990〜-999)
  - DMM_LINK_AFFILIATE_ID     : 購入リンク用 af_id
  - RESOLVER_BASE_URL         : Xserver VPS resolver (http://162.43.24.128)
  - RESOLVER_API_KEY          : resolver Bearer Token
  - SCHEDULER_RUN_ON_START    : "true" なら起動直後に 1 回 sync を実行 (任意)
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import traceback
from datetime import datetime
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

# このパッケージのジョブを再利用
from src.resolve_sample_urls import main as resolve_main
from src.sync_actress_profiles import main as actress_main
from src.sync_catalog import main as sync_main

TZ = ZoneInfo("Asia/Tokyo")

logger = logging.getLogger("scheduler")


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )


# ────────────────────────────────────────────────────────────────────
# 各ジョブを安全にラップする (例外をスケジューラに伝播させない)
# ────────────────────────────────────────────────────────────────────


async def _run_sync_catalog() -> None:
    """incremental モードで sync_catalog を呼ぶ。

    cron 想定 (元の sync-catalog.yml の引数を踏襲):
      python -m src.sync_catalog  (hits_per_floor=100, floors_filter=None)
    """
    logger.info("[job] sync_catalog start (incremental)")
    try:
        await sync_main(
            mode="incremental",
            hits_per_floor=100,
            floors_filter=None,  # デフォルトフロアを使う
            dry_run=False,
            start_date=None,
            end_date=None,
            incremental_gte=None,
            incremental_lte=None,
        )
        logger.info("[job] sync_catalog done")
    except Exception:
        logger.error("[job] sync_catalog FAILED\n%s", traceback.format_exc())


async def _run_resolve_sample_urls() -> None:
    logger.info("[job] resolve_sample_urls start")
    try:
        await resolve_main(
            concurrency=4,
            limit=None,
            dry_run=False,
        )
        logger.info("[job] resolve_sample_urls done")
    except Exception:
        logger.error("[job] resolve_sample_urls FAILED\n%s", traceback.format_exc())


async def _run_sync_actress_profiles() -> None:
    logger.info("[job] sync_actress_profiles start (--only-missing)")
    try:
        await actress_main(
            limit=None,
            only_missing=True,
            dry_run=False,
        )
        logger.info("[job] sync_actress_profiles done")
    except Exception:
        logger.error("[job] sync_actress_profiles FAILED\n%s", traceback.format_exc())


# ────────────────────────────────────────────────────────────────────
# Scheduler entrypoint
# ────────────────────────────────────────────────────────────────────


async def _amain() -> None:
    _setup_logging()
    logger.info(
        "scheduler boot: now=%s (Asia/Tokyo)",
        datetime.now(TZ).isoformat(timespec="seconds"),
    )

    # DATABASE_URL を簡易検査 (internal でなければ警告)
    db_url = os.getenv("DATABASE_URL", "")
    if "railway.internal" not in db_url:
        logger.warning(
            "DATABASE_URL does NOT use Railway internal network "
            "(no 'railway.internal' substring). Egress charges may apply. "
            "Use 'postgres.railway.internal:5432' in production."
        )

    scheduler = AsyncIOScheduler(timezone=TZ)

    # sync_catalog: 2 時間ごと (JST 08/10/12/14/16/18/20 時)
    scheduler.add_job(
        _run_sync_catalog,
        CronTrigger(hour="8,10,12,14,16,18,20", minute=0, timezone=TZ),
        id="sync_catalog",
        name="sync_catalog (incremental)",
        max_instances=1,
        coalesce=True,
    )

    # resolve_sample_urls: 毎日 03:00 JST
    scheduler.add_job(
        _run_resolve_sample_urls,
        CronTrigger(hour=3, minute=0, timezone=TZ),
        id="resolve_sample_urls",
        name="resolve_sample_urls",
        max_instances=1,
        coalesce=True,
    )

    # sync_actress_profiles: 毎日 04:00 JST
    scheduler.add_job(
        _run_sync_actress_profiles,
        CronTrigger(hour=4, minute=0, timezone=TZ),
        id="sync_actress_profiles",
        name="sync_actress_profiles (--only-missing)",
        max_instances=1,
        coalesce=True,
    )

    scheduler.start()
    logger.info("scheduler started. registered jobs:")
    for job in scheduler.get_jobs():
        logger.info("  - %s | next_run=%s", job.id, job.next_run_time)

    # 起動直後の 1 回実行 (デバッグ用、本番では false 推奨)
    if os.getenv("SCHEDULER_RUN_ON_START", "false").lower() == "true":
        logger.info("SCHEDULER_RUN_ON_START=true: kicking sync_catalog once")
        asyncio.create_task(_run_sync_catalog())

    # SIGTERM / SIGINT で安全に shutdown
    stop_event = asyncio.Event()

    def _on_signal(signum: int) -> None:
        logger.info("received signal %s, shutting down", signum)
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _on_signal, sig)
        except NotImplementedError:
            # Windows 等のフォールバック
            pass

    await stop_event.wait()
    scheduler.shutdown(wait=False)
    logger.info("scheduler stopped")


def main() -> None:
    try:
        asyncio.run(_amain())
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
