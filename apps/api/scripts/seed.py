"""モックデータをDBにシードするスクリプト

使い方:
  cd apps/api
  python scripts/seed.py
"""
import asyncio
import json
from datetime import date
from pathlib import Path

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.db.models.actress import Actress
from app.db.models.genre import Genre
from app.db.models.movie import Movie, MovieGenre, MovieActress

MOCK_PATH = Path(__file__).parent.parent / "app" / "mock_data" / "movies.json"


def _get_async_url(url: str) -> str:
    """postgresql:// を postgresql+asyncpg:// に正規化する。"""
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


def parse_date(value: str | None) -> date | None:
    """'YYYY-MM-DD'文字列をdateオブジェクトに変換。NoneはそのままNoneになる。"""
    if value is None:
        return None
    return date.fromisoformat(value)


async def seed(session: AsyncSession) -> None:
    # 既存データを全削除（中間テーブルから先に削除）
    await session.execute(delete(MovieGenre))
    await session.execute(delete(MovieActress))
    await session.execute(delete(Movie))
    await session.execute(delete(Genre))
    await session.execute(delete(Actress))
    await session.commit()
    print("🗑️  既存データを削除しました")

    with MOCK_PATH.open(encoding="utf-8") as f:
        movies_data: list[dict] = json.load(f)

    genre_cache: dict[str, Genre] = {}
    actress_cache: dict[str, Actress] = {}

    for data in movies_data:
        # メインレコード作成
        movie = Movie(
            id=data["id"],
            content_id=data.get("content_id"),
            product_id=data.get("product_id"),
            maker_product=data.get("maker_product"),
            title=data["title"],
            slug=data["slug"],
            description=data.get("description", ""),
            volume=data.get("volume"),
            image_url_list=data.get("image_url_list", ""),
            image_url_large=data.get("image_url_large", ""),
            sample_movie_url=data.get("sample_movie_url"),
            sample_embed_url=data.get("sample_embed_url", ""),
            affiliate_url=data.get("affiliate_url", ""),
            affiliate_url_en=data.get("affiliate_url_en"),
            price_list=data.get("price_list"),
            price_min=data.get("price_min"),
            release_date=parse_date(data.get("release_date")),
            delivery_date=parse_date(data.get("delivery_date")),
            rental_start_date=parse_date(data.get("rental_start_date")),
            primary_date=parse_date(data.get("primary_date")),
            review_count=data.get("review_count", 0),
            review_average=data.get("review_average"),
            director_name=data.get("director_name"),
            label_name=data.get("label_name"),
            maker_name=data.get("maker_name"),
        )
        session.add(movie)

        # ジャンル
        for genre_name in (data.get("genres") or []):
            if genre_name not in genre_cache:
                genre = Genre(name=genre_name)
                session.add(genre)
                genre_cache[genre_name] = genre
            genre = genre_cache[genre_name]
            await session.flush()  # idを確定させる
            session.add(MovieGenre(movie_id=movie.id, genre_id=genre.id))

        # 女優
        for actress_name in (data.get("actresses") or []):
            if actress_name not in actress_cache:
                actress = Actress(name=actress_name)
                session.add(actress)
                actress_cache[actress_name] = actress
            actress = actress_cache[actress_name]
            await session.flush()
            session.add(MovieActress(movie_id=movie.id, actress_id=actress.id))

    await session.commit()
    print(f"✅ {len(movies_data)}件のデータをシードしました")


async def main() -> None:
    engine = create_async_engine(_get_async_url(settings.DATABASE_URL), echo=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with session_factory() as session:
        await seed(session)
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
