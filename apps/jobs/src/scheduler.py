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
from datetime import date, datetime
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
# Bootstrap (起動直後の一括取得ジョブ)
# ────────────────────────────────────────────────────────────────────


async def _run_bootstrap() -> None:
    """起動直後に一括取得を走らせる。

    現状の DB データを補完するためのワンショットタスク。デフォルトパラメータで
    「2008-2026 / videoa,videoc」を取得、その後 resolve / actress / goods を順番に
    走らせる。現状、Worker は Railway Private Network で DB に接続しているため
    これらの実行によって Public Network egress は発生しない。

    環境変数:
      - SCHEDULER_BOOTSTRAP=true            : このジョブを有効化
      - BOOTSTRAP_START_YEAR=2008           : start year (含む)
      - BOOTSTRAP_END_YEAR=2026             : end year (含む)
      - BOOTSTRAP_FLOORS=videoa,videoc      : 動画フロア (コンマ区切り)
      - BOOTSTRAP_GOODS_FLOORS=goods        : グッズフロア (空で goods をスキップ)
      - BOOTSTRAP_SKIP_RESOLVE=false        : true で resolve をスキップ
      - BOOTSTRAP_SKIP_ACTRESS=false        : true で actress をスキップ
      - BOOTSTRAP_ACTRESS_ONLY_MISSING=true : actress を --only-missing で走らせる
    """
    start_year = int(os.getenv("BOOTSTRAP_START_YEAR", "2008"))
    end_year = int(os.getenv("BOOTSTRAP_END_YEAR", "2026"))
    video_floors = [
        f.strip()
        for f in os.getenv("BOOTSTRAP_FLOORS", "videoa,videoc").split(",")
        if f.strip()
    ]
    goods_floors_env = os.getenv("BOOTSTRAP_GOODS_FLOORS", "goods")
    goods_floors = [f.strip() for f in goods_floors_env.split(",") if f.strip()]
    skip_resolve = os.getenv("BOOTSTRAP_SKIP_RESOLVE", "false").lower() == "true"
    skip_actress = os.getenv("BOOTSTRAP_SKIP_ACTRESS", "false").lower() == "true"
    actress_only_missing = (
        os.getenv("BOOTSTRAP_ACTRESS_ONLY_MISSING", "true").lower() == "true"
    )

    logger.info(
        "=" * 70 + "\n"
        "[bootstrap] start: years=%d-%d video_floors=%s goods_floors=%s "
        "skip_resolve=%s skip_actress=%s actress_only_missing=%s\n" + "=" * 70,
        start_year, end_year, video_floors, goods_floors,
        skip_resolve, skip_actress, actress_only_missing,
    )

    # 1. sync_catalog (videoa + videoc) full 一気取得
    # 年単位でループし、sync_catalog 内部の月スライスに任せる。
    # ログを見やすくし、一部年だけのリトライもやりやすくするため。
    if video_floors:
        for year in range(start_year, end_year + 1):
            logger.info("[bootstrap] -- sync_catalog %d (full) --", year)
            try:
                await sync_main(
                    mode="full",
                    hits_per_floor=100,  # full モードでは使われないが必須引数
                    floors_filter=video_floors,
                    dry_run=False,
                    start_date=date(year, 1, 1),
                    end_date=date(year, 12, 31),
                )
                logger.info("[bootstrap] sync_catalog %d done", year)
            except Exception:
                logger.error(
                    "[bootstrap] sync_catalog %d FAILED, continuing\n%s",
                    year, traceback.format_exc(),
                )

    # 2. resolve_sample_urls (NULL を全件埋める)
    if not skip_resolve:
        logger.info("[bootstrap] -- resolve_sample_urls --")
        try:
            await resolve_main(concurrency=4, limit=None, dry_run=False)
            logger.info("[bootstrap] resolve_sample_urls done")
        except Exception:
            logger.error(
                "[bootstrap] resolve_sample_urls FAILED, continuing\n%s",
                traceback.format_exc(),
            )

    # 3. sync_actress_profiles
    if not skip_actress:
        logger.info(
            "[bootstrap] -- sync_actress_profiles (only_missing=%s) --",
            actress_only_missing,
        )
        try:
            await actress_main(
                limit=None, only_missing=actress_only_missing, dry_run=False
            )
            logger.info("[bootstrap] sync_actress_profiles done")
        except Exception:
            logger.error(
                "[bootstrap] sync_actress_profiles FAILED, continuing\n%s",
                traceback.format_exc(),
            )

    # 4. sync_catalog (goods) full 取得
    # goods は「DB に存在する女優名」でフィルタされるため、必ず actress 取得のあとに走らせる。
    if goods_floors:
        for year in range(start_year, end_year + 1):
            logger.info("[bootstrap] -- sync_catalog goods %d --", year)
            try:
                await sync_main(
                    mode="full",
                    hits_per_floor=100,
                    floors_filter=goods_floors,
                    dry_run=False,
                    start_date=date(year, 1, 1),
                    end_date=date(year, 12, 31),
                )
                logger.info("[bootstrap] sync_catalog goods %d done", year)
            except Exception:
                logger.error(
                    "[bootstrap] sync_catalog goods %d FAILED, continuing\n%s",
                    year, traceback.format_exc(),
                )

    logger.info("=" * 70 + "\n[bootstrap] ALL DONE\n" + "=" * 70)


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

    # resolve_sample_urls: 毎日 11:00 JST (日中帯に移動、サービスピークを避ける)
    scheduler.add_job(
        _run_resolve_sample_urls,
        CronTrigger(hour=11, minute=0, timezone=TZ),
        id="resolve_sample_urls",
        name="resolve_sample_urls",
        max_instances=1,
        coalesce=True,
    )

    # sync_actress_profiles: 毎日 13:00 JST (日中帯に移動)
    scheduler.add_job(
        _run_sync_actress_profiles,
        CronTrigger(hour=13, minute=0, timezone=TZ),
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

    # 起動直後のブートストラップ (一括取り直しツール)
    # デフォルトで 2008-2026 / videoa,videoc を full 取得 → resolve → actress → goods
    # を順番に走らせる。完了したら環境変数を false に戻して redeploy すること。
    if os.getenv("SCHEDULER_BOOTSTRAP", "false").lower() == "true":
        logger.info("SCHEDULER_BOOTSTRAP=true: kicking bootstrap pipeline")
        asyncio.create_task(_run_bootstrap())

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
