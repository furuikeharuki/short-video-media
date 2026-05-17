import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import settings
from app.db.base import Base

# モデルを全てimportしてBaseのmetadataに登録する
import app.db.models  # noqa: F401

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _get_async_url() -> str:
    """postgresql:// を postgresql+asyncpg:// に正規化する。"""
    url = settings.DATABASE_URL
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


def run_migrations_offline() -> None:
    context.configure(
        url=_get_async_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online_async() -> None:
    connectable = create_async_engine(_get_async_url())
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    """非同期マイグレーションを実行する。

    FastAPI lifespan のように 既にイベントループが動いている環境からも
    呼べるよう、実行中ループの有無を見て動作を切り替える。
    """
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None

    if running_loop is None:
        # CLI 等、ループが無い通常ケース
        asyncio.run(run_migrations_online_async())
    else:
        # 既存ループが動作中の場合は、別スレッドで新しいループを起動して実行
        import threading

        error: list[BaseException] = []

        def _worker() -> None:
            try:
                asyncio.run(run_migrations_online_async())
            except BaseException as exc:  # noqa: BLE001
                error.append(exc)

        thread = threading.Thread(target=_worker, daemon=False)
        thread.start()
        thread.join()
        if error:
            raise error[0]


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
