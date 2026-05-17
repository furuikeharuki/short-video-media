"""ホーム画面用の集約エンドポイント。
複数セクションを 1 リクエストで返す。
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.repositories.movie_repository import (
    get_movies_by_genre,
    get_new_release_movies,
    get_top_genres_by_movie_count,
)
from app.schemas.home import HomeResponse, HomeSection
from app.services.feed_service import _to_card
from app.services.ranking_service import get_popular_search_genres, get_ranking


# ジャンルとして提示したくない技術タグ・メタタグ
GENRE_EXCLUDE = {"ハイビジョン", "独占配信", "単体作品", "4K", "デジモ", "ギリモザ"}

router = APIRouter()


@router.get("/home", response_model=HomeResponse)
async def get_home(
    section_limit: int = Query(default=12, ge=1, le=30),
    db: AsyncSession = Depends(get_db),
) -> HomeResponse:
    sections: list[HomeSection] = []

    # 1. 本日配信開始 (今日の primary_date の作品のみ。フォールバックなし)
    new_movies = await get_new_release_movies(
        db, limit=section_limit, fallback_days=0
    )
    sections.append(
        HomeSection(
            key="new",
            title="本日配信開始",
            items=[_to_card(m) for m in new_movies],
        )
    )

    # 2. 月間ランキング
    monthly = await get_ranking(db, period="monthly", limit=section_limit)
    sections.append(HomeSection(key="ranking_monthly", title="月間ランキング", items=monthly))

    # 3. 週間ランキング
    weekly = await get_ranking(db, period="weekly", limit=section_limit)
    sections.append(HomeSection(key="ranking_weekly", title="週間ランキング", items=weekly))

    # 4. デイリーランキング
    daily = await get_ranking(db, period="daily", limit=section_limit)
    sections.append(HomeSection(key="ranking_daily", title="デイリーランキング", items=daily))

    # 5-7. 検索数の高いジャンル 1〜3
    # 検索イベントがあるなら検索数順。不足分は DB に存在する「作品数の多いジャンル」で補充する。
    popular_raw = await get_popular_search_genres(db, period="weekly", limit=10)
    popular = [g for g in popular_raw if g not in GENRE_EXCLUDE]
    seen: set[str] = set(popular)
    if len(popular) < 3:
        fallback = await get_top_genres_by_movie_count(
            db, limit=10, exclude=GENRE_EXCLUDE | seen
        )
        for g in fallback:
            if len(popular) >= 3:
                break
            if g in seen:
                continue
            popular.append(g)
            seen.add(g)

    for i, genre_name in enumerate(popular[:3], start=1):
        movies = await get_movies_by_genre(db, genre_name=genre_name, limit=section_limit)
        sections.append(
            HomeSection(
                key=f"genre_{i}",
                title=f"#{genre_name}",
                subtitle=f"検索数の高いジャンル{i}",
                genre=genre_name,
                items=[_to_card(m) for m in movies],
            )
        )

    return HomeResponse(sections=sections)
