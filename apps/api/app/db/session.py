from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

# DB 接続プール設定。
# Railway Postgres は idle 接続を ~5 分で切断するため、pool_recycle をそれより短くして
# 古い接続を先に破棄する。pool_pre_ping はリクエスト直前に軽量な SELECT 1 で
# 生存確認して、サーバー側タイムアウトしたコネクションを使い回さないようにする。
engine = create_async_engine(
    settings.async_database_url,
    echo=False,
    pool_size=settings.DB_POOL_SIZE,
    max_overflow=settings.DB_MAX_OVERFLOW,
    pool_recycle=settings.DB_POOL_RECYCLE,
    pool_pre_ping=settings.DB_POOL_PRE_PING,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,
    class_=AsyncSession,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session
