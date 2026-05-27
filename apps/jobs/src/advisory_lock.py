"""Postgres advisory lock を使った「ジョブ単独実行」ガード。

Railway や手動キックなど複数プロセスが同一ジョブを同時に走らせると、
DB upsert 競合・DMM API レート枯渇・goods フィルタ不整合の原因になる。
このモジュールは `pg_try_advisory_lock(key)` を取得できなかったら
ジョブを no-op で抜けるためのコンテキストマネージャを提供する。

設計:
  - ロックキーはジョブ名から SHA-1 を計算し、先頭 8 byte (符号付き 64bit) を採用。
  - `pg_try_advisory_lock` (NOT *_xact_*) はセッションスコープでロックを保持し、
    `pg_advisory_unlock` で明示的に解放する。
  - asyncpg / SQLAlchemy のセッションを 1 本開き、ロック取得失敗ならその場で
    ロールバックして抜ける。スケジューラ自体は止めない。
  - DATABASE_URL が未設定なら advisory lock を取らずそのままジョブを走らせる
    (テスト / ローカルデバッグ時に止まらないようにするフォールバック)。

使い方:
    async with advisory_lock("sync_catalog") as acquired:
        if not acquired:
            return
        await do_the_work()
"""
from __future__ import annotations

import hashlib
import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

logger = logging.getLogger(__name__)


def _job_key(name: str) -> int:
    """ジョブ名から 64bit 符号付き整数の advisory lock キーを作る。

    `pg_try_advisory_lock` は `bigint` を受け取るため、SHA-1 の先頭 8 byte を
    符号付き 64bit (big-endian) として解釈する。
    """
    digest = hashlib.sha1(f"short-video-media:job:{name}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=True)


def _get_async_url(url: str) -> str:
    """DATABASE_URL を asyncpg 用に正規化する (sync_catalog._get_async_url と同等)。"""
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+asyncpg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


@asynccontextmanager
async def advisory_lock(name: str) -> AsyncIterator[bool]:
    """`name` のジョブ単独実行ロックを取りに行く。

    Yields:
        True  : ロック取得済み。ジョブ本体を実行してよい。
        False : 他プロセスが同じジョブを実行中なので、当該呼び出しはスキップすべき。

    Notes:
        - `DATABASE_URL` 未設定なら警告ログを出して常に True を yield する。
        - SQLAlchemy / asyncpg のインポートに失敗した場合も同様に True を yield する
          (これらは scheduler 本体ですでに使われているため通常起こらない)。
        - ロック取得後の例外は呼び出し側に伝播。finally で必ずロックを解放する。
    """
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        logger.warning(
            "advisory_lock(%s): DATABASE_URL not set; skipping lock", name
        )
        yield True
        return

    try:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import create_async_engine
    except ImportError:
        logger.warning(
            "advisory_lock(%s): SQLAlchemy import failed; skipping lock", name
        )
        yield True
        return

    key = _job_key(name)
    engine = create_async_engine(_get_async_url(db_url), pool_pre_ping=True)
    conn = None
    acquired = False
    try:
        conn = await engine.connect()
        result = await conn.execute(
            text("SELECT pg_try_advisory_lock(:k)"), {"k": key}
        )
        row = result.first()
        acquired = bool(row[0]) if row is not None else False
        if not acquired:
            logger.warning(
                "advisory_lock(%s): another instance holds the lock; skipping run",
                name,
            )
        try:
            yield acquired
        finally:
            if acquired:
                try:
                    await conn.execute(
                        text("SELECT pg_advisory_unlock(:k)"), {"k": key}
                    )
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "advisory_lock(%s): unlock failed", name, exc_info=True
                    )
    except Exception:  # noqa: BLE001
        # DB に繋がらない等の致命的失敗。安全側に倒してロックなしで実行を許可する。
        # こうしておかないと、DB 障害時にスケジューラ全体が空回りする。
        logger.warning(
            "advisory_lock(%s): could not acquire lock due to DB error; "
            "running without lock",
            name,
            exc_info=True,
        )
        if not acquired:
            yield True
    finally:
        if conn is not None:
            try:
                await conn.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            await engine.dispose()
        except Exception:  # noqa: BLE001
            pass
