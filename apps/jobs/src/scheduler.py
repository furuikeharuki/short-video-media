"""Railway 内 jobs-worker サービスの常駐エントリポイント。

Postgres へは Railway Private Network 経由 (`postgres.railway.internal:5432`) で
接続するため、SELECT / RETURNING の応答が Public Network egress として
カウントされない。これにより GitHub Actions cron 経由で発生していた
egress 大量課金 ($61/2日 など) を完全にゼロ化することが目的。

スケジュール (JST 想定 / デフォルト):
  - sync_catalog (incremental)        : 2 時間ごと (08, 10, 12, 14, 16, 18, 20 JST)
  - sync_actress_profiles (--only-missing) : 毎日 13:00 JST

  ※ sample_movie_url の DB キャッシュは廃止された (apps/api 内で都度抽出する設計)
  ため、関連の resolve_sample_urls / resolve_sample_urls_full_refresh ジョブは無い。

タイムゾーン:
  - APScheduler の cron は TZ を Asia/Tokyo 固定で評価する

異常時:
  - 各ジョブは内部で例外を握りつぶしてログ出力するだけ。スケジューラ自体は
    例外で止めない。Railway logs で詳細を追える。

環境変数 (すべて Railway Variables / .env で設定):
  - DATABASE_URL              : postgresql://...@postgres.railway.internal:5432/...
  - DMM_API_ID                : DMM Webservice API ID
  - DMM_AFFILIATE_ID          : DMM API 呼び出し用 (-990〜-999)
  - DMM_LINK_AFFILIATE_ID     : 購入リンク用 af_id
  - SCHEDULER_RUN_ON_START    : "true" なら起動直後に 1 回 sync_catalog を実行 (任意)

定期実行 (cron) の取得対象を環境変数で調整するための SCHEDULE_* 変数群
(すべて任意、未設定なら現行挙動を維持):
  - SCHEDULE_ENABLE_SYNC_CATALOG          : "false" でジョブ登録自体をスキップ
  - SCHEDULE_ENABLE_ACTRESS_PROFILES      : "false" でジョブ登録自体をスキップ
  - SCHEDULE_SYNC_CATALOG_MODE            : "incremental" (デフォルト) / "full"
  - SCHEDULE_SYNC_CATALOG_FLOORS          : 取得フロアをコンマ区切り指定。
                                            未設定なら sync_catalog のデフォルト
                                            (動画フロア + goods) を使う
  - SCHEDULE_SYNC_CATALOG_HITS_PER_FLOOR  : 1 floor あたりの取得件数 (デフォルト 100)
  - SCHEDULE_ACTRESS_ONLY_MISSING         : "false" にすると全女優プロフィール再取得
  - SCHEDULE_ACTRESS_LIMIT                : 1 回の sync_actress_profiles で処理する件数上限
  - SCHEDULE_SYNC_CATALOG_CRON_HOUR       : 例 "8,10,12,14,16,18,20" (デフォルト)
  - SCHEDULE_SYNC_CATALOG_CRON_MINUTE     : 例 "0" (デフォルト)
  - SCHEDULE_ACTRESS_CRON_HOUR            : 例 "13" (デフォルト)
  - SCHEDULE_ACTRESS_CRON_MINUTE          : 例 "0" (デフォルト)
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
from src.advisory_lock import advisory_lock
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
# 環境変数ユーティリティ
# ────────────────────────────────────────────────────────────────────


def _env_bool(name: str, default: bool) -> bool:
    """環境変数を bool として読む。未設定 / 空文字なら default。"""
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int | None) -> int | None:
    """環境変数を int として読む。未設定 / 空文字 / 不正値なら default。

    default=None を返すケースで「リミットなし」を表現するため Optional。
    """
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("invalid %s=%r, falling back to %r", name, raw, default)
        return default


def _env_floors(name: str) -> list[str] | None:
    """カンマ区切りのフロアリストを読む。未設定なら None を返す。

    None は呼び出し側で「sync_catalog 側のデフォルト挙動を使う」意味になる。
    """
    raw = os.getenv(name)
    if raw is None:
        return None
    parts = [f.strip() for f in raw.split(",") if f.strip()]
    return parts if parts else None


# ────────────────────────────────────────────────────────────────────
# 各ジョブを安全にラップする (例外をスケジューラに伝播させない)
# ────────────────────────────────────────────────────────────────────


async def _run_sync_catalog() -> None:
    """sync_catalog を呼ぶ (定期実行)。

    SCHEDULE_* 環境変数で取得対象を上書きできる。未設定時は従来挙動
    (mode=incremental, hits_per_floor=100, floors_filter=None) を維持。

    複数プロセスでの同時実行を防ぐため Postgres advisory lock を取る。
    取れなければ "他に走っている" 扱いでスキップ (no-op)。
    """
    mode = os.getenv("SCHEDULE_SYNC_CATALOG_MODE", "incremental").strip() or "incremental"
    hits_per_floor = _env_int("SCHEDULE_SYNC_CATALOG_HITS_PER_FLOOR", 100) or 100
    floors_filter = _env_floors("SCHEDULE_SYNC_CATALOG_FLOORS")
    logger.info(
        "[job] sync_catalog start (mode=%s, hits_per_floor=%d, floors_filter=%s)",
        mode, hits_per_floor, floors_filter,
    )
    try:
        async with advisory_lock("sync_catalog") as acquired:
            if not acquired:
                return
            await sync_main(
                mode=mode,
                hits_per_floor=hits_per_floor,
                floors_filter=floors_filter,
                dry_run=False,
                start_date=None,
                end_date=None,
                incremental_gte=None,
                incremental_lte=None,
            )
        logger.info("[job] sync_catalog done")
    except Exception:
        logger.error("[job] sync_catalog FAILED\n%s", traceback.format_exc())


async def _run_sync_actress_profiles() -> None:
    only_missing = _env_bool("SCHEDULE_ACTRESS_ONLY_MISSING", True)
    limit = _env_int("SCHEDULE_ACTRESS_LIMIT", None)
    logger.info(
        "[job] sync_actress_profiles start (only_missing=%s, limit=%s)",
        only_missing, limit,
    )
    try:
        async with advisory_lock("sync_actress_profiles") as acquired:
            if not acquired:
                return
            await actress_main(
                limit=limit,
                only_missing=only_missing,
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
    「2008-2026 / videoa,videoc」を取得、その後 actress / goods を順番に走らせる。
    sample_movie_url の DB キャッシュは廃止したため bootstrap でも解決ステップは無い。

    環境変数:
      - SCHEDULER_BOOTSTRAP=true            : このジョブを有効化
      - BOOTSTRAP_START_YEAR=2008           : start year (含む)
      - BOOTSTRAP_END_YEAR=2026             : end year (含む)
      - BOOTSTRAP_FLOORS=videoa,videoc      : 動画フロア (コンマ区切り)
      - BOOTSTRAP_GOODS_FLOORS=goods        : グッズフロア (空で goods をスキップ)
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
    skip_actress = os.getenv("BOOTSTRAP_SKIP_ACTRESS", "false").lower() == "true"
    actress_only_missing = (
        os.getenv("BOOTSTRAP_ACTRESS_ONLY_MISSING", "true").lower() == "true"
    )
    # 年×フロアの並列実行数 (デフォルト 1 = 直列)。
    #
    # デフォルトを 1 にしている理由:
    #   - 本番 Xserver VPS (RAM 1.9GB) で concurrency=4 だと OOM kill されるため。
    #   - 1 ジョブ (1 年×フロア) の python プロセスが 約 700-750MB 使うため、
    #     RAM 4GB 未満のホストでは 1 以上にしない方が安全。
    #
    # メモリに余裕があるホスト (目安: RAM ≥ 4GB) では .env で BOOTSTRAP_CONCURRENCY=2~4 に
    # 上げると bootstrap 全体の所要時間をその倍率だけ短縮できる。
    # DMM API レートは sync_catalog 内部の AsyncLimiter (DMM_API_RPS) が全体で保つので
    # 並列度を上げても DMM 側に burst は掛からない。
    bootstrap_concurrency = max(
        1, int(os.getenv("BOOTSTRAP_CONCURRENCY", "1"))
    )

    logger.info(
        "=" * 70 + "\n"
        "[bootstrap] start: years=%d-%d video_floors=%s goods_floors=%s "
        "skip_actress=%s actress_only_missing=%s concurrency=%d\n" + "=" * 70,
        start_year, end_year, video_floors, goods_floors,
        skip_actress, actress_only_missing, bootstrap_concurrency,
    )

    async def _run_year_full(
        *, year: int, floors: list[str], label: str
    ) -> None:
        """1 年分の sync_catalog (full) を走らせる単位ジョブ。"""
        logger.info("[bootstrap] -- %s %d (full) start --", label, year)
        try:
            await sync_main(
                mode="full",
                hits_per_floor=100,  # full モードでは使われないが必須引数
                floors_filter=floors,
                dry_run=False,
                start_date=date(year, 1, 1),
                end_date=date(year, 12, 31),
            )
            logger.info("[bootstrap] %s %d done", label, year)
        except Exception:
            logger.error(
                "[bootstrap] %s %d FAILED, continuing\n%s",
                label, year, traceback.format_exc(),
            )

    async def _run_years_parallel(
        *, floors: list[str], label: str
    ) -> None:
        """年単位の sync_catalog を Semaphore で並列実行する。"""
        if not floors:
            return
        sem = asyncio.Semaphore(bootstrap_concurrency)

        async def _bounded(year: int) -> None:
            async with sem:
                await _run_year_full(year=year, floors=floors, label=label)

        await asyncio.gather(
            *(_bounded(y) for y in range(start_year, end_year + 1))
        )

    # 1. sync_catalog (videoa + videoc) full 一気取得 (年×フロアで並列)
    # sync_catalog 内部の月スライスはそのまま使えるため、年単位で並列に走らせる。
    # AsyncLimiter で DMM API レートは保たれるので、並列度を上げても API 側の負荷は変わらない。
    await _run_years_parallel(floors=video_floors, label="sync_catalog")

    # 2. sync_actress_profiles (シーケンシャル、actress テーブルを使う goods より先)
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

    # 3. sync_catalog (goods) full 取得 (年並列)
    # goods は "DB に存在する女優名" でフィルタされるため、必ず actress 取得のあとに走らせる。
    await _run_years_parallel(floors=goods_floors, label="sync_catalog goods")

    logger.info("=" * 70 + "\n[bootstrap] ALL DONE\n" + "=" * 70)


# ────────────────────────────────────────────────────────────────────
# Job 登録 (テストから単体で呼べるよう関数化)
# ────────────────────────────────────────────────────────────────────


def _register_jobs(scheduler: AsyncIOScheduler) -> None:
    """SCHEDULE_* 環境変数に応じて定期ジョブを登録する。

    SCHEDULE_ENABLE_* が "false" のときはジョブ自体を追加しない。
    cron 時刻も SCHEDULE_*_CRON_HOUR / SCHEDULE_*_CRON_MINUTE で上書きできる。
    未設定時はすべてデフォルト挙動を維持する。
    """
    # sync_catalog: 2 時間ごと (JST 08/10/12/14/16/18/20 時)
    if _env_bool("SCHEDULE_ENABLE_SYNC_CATALOG", True):
        sync_hour = os.getenv("SCHEDULE_SYNC_CATALOG_CRON_HOUR", "8,10,12,14,16,18,20")
        sync_minute = os.getenv("SCHEDULE_SYNC_CATALOG_CRON_MINUTE", "0")
        scheduler.add_job(
            _run_sync_catalog,
            CronTrigger(hour=sync_hour, minute=sync_minute, timezone=TZ),
            id="sync_catalog",
            name="sync_catalog",
            max_instances=1,
            coalesce=True,
        )
    else:
        logger.info("SCHEDULE_ENABLE_SYNC_CATALOG=false: skipping sync_catalog job")

    # sync_actress_profiles: 毎日 13:00 JST (日中帯)
    if _env_bool("SCHEDULE_ENABLE_ACTRESS_PROFILES", True):
        actress_hour = os.getenv("SCHEDULE_ACTRESS_CRON_HOUR", "13")
        actress_minute = os.getenv("SCHEDULE_ACTRESS_CRON_MINUTE", "0")
        scheduler.add_job(
            _run_sync_actress_profiles,
            CronTrigger(hour=actress_hour, minute=actress_minute, timezone=TZ),
            id="sync_actress_profiles",
            name="sync_actress_profiles",
            max_instances=1,
            coalesce=True,
        )
    else:
        logger.info(
            "SCHEDULE_ENABLE_ACTRESS_PROFILES=false: skipping sync_actress_profiles job"
        )


# ────────────────────────────────────────────────────────────────────
# Scheduler entrypoint
# ────────────────────────────────────────────────────────────────────


async def _amain() -> None:
    _setup_logging()
    logger.info(
        "scheduler boot: now=%s (Asia/Tokyo)",
        datetime.now(TZ).isoformat(timespec="seconds"),
    )

    # DATABASE_URL を簡易検査。DEPLOY_TARGET によって望ましいホスト名が異なる:
    #   railway : *.railway.internal  (Private Network 経由で egress 課金回避)
    #   xserver : compose サービス名 (db / postgres) or 同一 VPS 内 loopback
    #   aws     : *.rds.amazonaws.com もしくは VPC 内プライベート IP
    #   それ以外 : 検査しない (development 等)
    deploy_target = os.getenv("DEPLOY_TARGET", "railway").lower()
    db_url = os.getenv("DATABASE_URL", "")
    if deploy_target == "railway":
        if "railway.internal" not in db_url:
            logger.warning(
                "DEPLOY_TARGET=railway but DATABASE_URL does NOT use "
                "Railway private network ('railway.internal' missing). "
                "Egress charges may apply. "
                "Use 'postgres.railway.internal:5432' in production."
            )
    elif deploy_target == "xserver":
        # Compose ネットワーク内 (db / postgres) or 同一 VPS の 127.0.0.1 / unix socket。
        # それ以外は設定ミスの可能性が高いが、外部 DB 利用も将来あり得るので
        # warning だけに留めて起動は止めない。
        if not any(
            token in db_url
            for token in ("@db:", "@postgres:", "@db/", "@postgres/", "127.0.0.1", "localhost", "/var/run")
        ):
            logger.warning(
                "DEPLOY_TARGET=xserver but DATABASE_URL host does not look "
                "like a local Postgres (expected '@db', '@postgres', "
                "'127.0.0.1', 'localhost', or unix socket)."
            )
    elif deploy_target == "aws":
        if "localhost" in db_url or "127.0.0.1" in db_url:
            logger.warning(
                "DEPLOY_TARGET=aws but DATABASE_URL points to localhost. "
                "Use an RDS / Aurora endpoint or a VPC private IP."
            )
    else:
        logger.info(
            "DEPLOY_TARGET=%s: skipping DATABASE_URL host validation",
            deploy_target,
        )

    scheduler = AsyncIOScheduler(timezone=TZ)
    _register_jobs(scheduler)

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
