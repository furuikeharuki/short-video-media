"""モックデータをDBにシードするスクリプト

使い方:
  cd apps/api
  python scripts/seed.py
"""
import asyncio
import json
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.db.models.genre import Genre
from app.db.models.movie import Movie, MovieGenre, MoviePerformer
from app.db.models.performer import Performer

MOCK_PATH = Path(__file__).parent.parent / "app" / "mock_data" / "movies.json"


async def seed(session: AsyncSession) -> None:
    with MOCK_PATH.open(encoding="utf-8") as f:
        movies_data: list[dict] = json.load(f)

    genre_cache: dict[str, Genre] = {}
    performer_cache: dict[str, Performer] = {}

    for data in movies_data:
        # メインレコード作成
        movie = Movie(
            id=data["id"],
            fanza_id=data.get("fanza_id"),
            title=data["title"],
            slug=data["slug"],
            description=data.get("description", ""),
            thumbnail_url=data.get("thumbnail_url", ""),
            sample_embed_url=data.get("sample_embed_url", ""),
            affiliate_url=data.get("affiliate_url", ""),
        )
        session.add(movie)

        # ジャンル
        for genre_name in data.get("genres", []):
            if genre_name not in genre_cache:
                genre = Genre(name=genre_name)
                session.add(genre)
                genre_cache[genre_name] = genre
            genre = genre_cache[genre_name]
            await session.flush()  # idを確定させる
            session.add(MovieGenre(movie_id=movie.id, genre_id=genre.id))

        # 女優
        for actress_name in data.get("actresses", []):
            if actress_name not in performer_cache:
                performer = Performer(name=actress_name)
                session.add(performer)
                performer_cache[actress_name] = performer
            performer = performer_cache[actress_name]
            await session.flush()
            session.add(MoviePerformer(movie_id=movie.id, performer_id=performer.id))

    await session.commit()
    print(f"✅ {len(movies_data)}件のメッセージをシードしました")


async def main() -> None:
    engine = create_async_engine(settings.DATABASE_URL, echo=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with session_factory() as session:
        await seed(session)
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
