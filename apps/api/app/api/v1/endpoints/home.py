"""ホーム画面用の集約エンドポイント。
複数セクションを 1 リクエストで返す。
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.repositories.movie_repository import (
    get_movies_by_genre,
    get_new_release_movies,
    get_recent_release_movies,
    get_top_genres_by_movie_count,
)
from app.schemas.actress import GoodsCard
from app.schemas.feed import FeedResponse
from app.schemas.home import (
    HomeActressSection,
    HomeGoodsSection,
    HomeResponse,
    HomeSection,
)
from app.services.feed_service import _to_card
from app.services.ranking_service import (
    get_popular_actresses_all_time,
    get_popular_all_time,
    get_popular_products_all_time,
    get_popular_search_genres,
    get_ranking,
)


class GoodsFeedResponse(BaseModel):
    """/home/section?key=popular_products のレスポンス。
    動画 (FeedResponse) と並列の goods 版。next_cursor は同じ規約。
    """
    items: list[GoodsCard]
    next_cursor: str | None = None


# ジャンルとして提示したくない技術タグ・メタタグ
GENRE_EXCLUDE = {"ハイビジョン", "独占配信", "単体作品", "4K", "デジモ", "ギリモザ"}

router = APIRouter()


@router.get("/home", response_model=HomeResponse)
async def get_home(
    section_limit: int = Query(default=12, ge=1, le=30),
    db: AsyncSession = Depends(get_db),
) -> HomeResponse:
    sections: list[HomeSection] = []
    actress_sections: list[HomeActressSection] = []
    goods_sections: list[HomeGoodsSection] = []

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

    # 2. 新着 (今日を除いた 1ヶ月以内に配信された作品を配信日降順)
    recent_movies = await get_recent_release_movies(db, days=30, limit=section_limit)
    sections.append(
        HomeSection(
            key="recent",
            title="新着",
            subtitle="直近1ヶ月に配信された作品",
            items=[_to_card(m) for m in recent_movies],
        )
    )

    # 3. 人気動画 (全期間の総視聴回数順)
    popular_items = await get_popular_all_time(db, limit=section_limit)
    sections.append(
        HomeSection(
            key="popular",
            title="人気動画",
            subtitle="総視聴回数順",
            items=popular_items,
        )
    )

    # 3b. 人気女優 (全期間のアフィリエイトクリック総数を女優単位で集計)
    popular_actresses = await get_popular_actresses_all_time(db, limit=section_limit)
    if popular_actresses:
        actress_sections.append(
            HomeActressSection(
                key="popular_actresses",
                title="人気女優",
                subtitle="アフィリエイトクリック総数順",
                items=popular_actresses,
            )
        )

    # 3c. 人気商品 (Goods テーブルから review_count 順で取得)。
    #     動画 (Movie) ではなく商品 (Goods) を返すため、専用フィールド
    #     goods_sections に入れる (フロントは GoodsCard として描画する)。
    popular_products = await get_popular_products_all_time(db, limit=section_limit)
    if popular_products:
        goods_sections.append(
            HomeGoodsSection(
                key="popular_products",
                title="人気商品",
                subtitle="レビュー件数順",
                items=popular_products,
            )
        )

    # 4. 日間ランキング
    daily = await get_ranking(db, period="daily", limit=section_limit)
    sections.append(HomeSection(key="ranking_daily", title="日間ランキング", items=daily))

    # 5. 週間ランキング
    weekly = await get_ranking(db, period="weekly", limit=section_limit)
    sections.append(HomeSection(key="ranking_weekly", title="週間ランキング", items=weekly))

    # 6. 月間ランキング
    monthly = await get_ranking(db, period="monthly", limit=section_limit)
    sections.append(HomeSection(key="ranking_monthly", title="月間ランキング", items=monthly))

    # 7-9. 検索数の高いジャンル 1〜3
    # 検索イベントがあるなら検索数順。不足分は DB に存在する「作品数の多いジャンル」で補充する。
    popular_raw = await get_popular_search_genres(db, period="weekly", limit=10)
    popular_candidates = [g for g in popular_raw if g not in GENRE_EXCLUDE]

    # 個々のジャンルで作品を取り、空セクションになるものはスキップする
    genre_sections: list[HomeSection] = []
    used: set[str] = set()
    rank = 0

    async def _try_add(name: str) -> None:
        nonlocal rank
        if rank >= 3 or name in used:
            return
        movies = await get_movies_by_genre(db, genre_name=name, limit=section_limit)
        if not movies:
            return
        rank += 1
        used.add(name)
        genre_sections.append(
            HomeSection(
                key=f"genre_{rank}",
                title=f"#{name}",
                subtitle=f"検索数の高いジャンル{rank}",
                genre=name,
                items=[_to_card(m) for m in movies],
            )
        )

    for g in popular_candidates:
        await _try_add(g)
        if rank >= 3:
            break

    if rank < 3:
        fallback = await get_top_genres_by_movie_count(
            db, limit=10, exclude=GENRE_EXCLUDE | used
        )
        for g in fallback:
            await _try_add(g)
            if rank >= 3:
                break

    sections.extend(genre_sections)

    return HomeResponse(
        sections=sections,
        actress_sections=actress_sections,
        goods_sections=goods_sections,
    )



# section ごとの "もっと見る" ・ フィード継足し用エンドポイント。
# offset/limit を受け取り、同じ並び順で指定区間を SQL OFFSET/LIMIT で返す。
#
# ページネーション設計:
# - サーバは limit + 1 件を SQL に渡して「ルックアヘッド 1 件」だけ余分に取る。
# - len(items) > limit なら次ページあり → next_cursor = str(offset + limit)
# - len(items) <= limit なら末尾確定 → next_cursor = None
# これでデータが 10 万件規模になっても 1 ページあたりの計算量は limit 件に収まる。
#
# 並び順の安定性:
# 集計クエリ (aggregate_view_ranking / _all_time) は count desc だけだと tie で
# 順序が不安定になるため、二次キーとして Event.slug を追加している。
# 同様に movie_repository 側も Movie.id を二次キーにして、offset をぶん進めても
# ページ間で重複・欠落が起きないようにしている。


def _to_response(items: list, offset: int, limit: int) -> FeedResponse:
    """limit+1 件取った items を FeedResponse に変換する。

    items は最大 limit+1 件しか入っていない前提。
    len(items) > limit なら「次ページあり」と判定し、
    クライアントに返すのは先頭 limit 件のみ。
    """
    has_next = len(items) > limit
    page = items[:limit]
    next_cursor = str(offset + limit) if has_next else None
    return FeedResponse(items=page, next_cursor=next_cursor)


@router.get("/home/section", response_model=FeedResponse)
async def get_home_section(
    key: str = Query(..., min_length=1),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    genre: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> FeedResponse:
    """ホームセクションと同じ順番で、offset+limit の区間を SQL OFFSET/LIMIT で返す。

    - key='popular'         : 総視聴回数順 (人気)
    - key='ranking_daily'   : 日間ランキング
    - key='ranking_weekly'  : 週間ランキング
    - key='ranking_monthly' : 月間ランキング
    - key='new'             : 本日配信開始 (今日付ゼロ件ならフォールバック)
    - key='recent'          : 新着 (直近1ヶ月、今日を除く)
    - key='genre'           : ジャンル絞り込み (必ず genre クエリを伴う)
    """
    # "次ページがあるか" 判定用に 1 件余分に取る。
    # クライアントに返すのはその 1 件を除いた 先頭 limit 件だけ。
    fetch_limit = limit + 1

    if key == "popular":
        items = await get_popular_all_time(db, limit=fetch_limit, offset=offset)
        return _to_response(items, offset, limit)

    if key == "popular_products":
        # 商品 (Goods) は MovieCard と型が異なるので、このエンドポイントでは扱わず
        # 専用エンドポイント /home/section/popular_products に誘導する。
        raise HTTPException(
            status_code=400,
            detail="use /api/v1/home/section/popular_products for goods items",
        )

    if key == "ranking_daily":
        items = await get_ranking(db, period="daily", limit=fetch_limit, offset=offset)
        return _to_response(items, offset, limit)

    if key == "ranking_weekly":
        items = await get_ranking(db, period="weekly", limit=fetch_limit, offset=offset)
        return _to_response(items, offset, limit)

    if key == "ranking_monthly":
        items = await get_ranking(db, period="monthly", limit=fetch_limit, offset=offset)
        return _to_response(items, offset, limit)

    if key == "new":
        # "本日配信開始" は本日分を優先、ゼロなら直近にフォールバック。
        movies = await get_new_release_movies(
            db, limit=fetch_limit, fallback_days=0, offset=offset
        )
        items = [_to_card(m) for m in movies]
        return _to_response(items, offset, limit)

    if key == "recent":
        movies = await get_recent_release_movies(
            db, days=30, limit=fetch_limit, offset=offset
        )
        items = [_to_card(m) for m in movies]
        return _to_response(items, offset, limit)

    if key == "genre":
        if not genre:
            raise HTTPException(status_code=400, detail="genre query is required when key='genre'")
        movies = await get_movies_by_genre(
            db, genre_name=genre, limit=fetch_limit, offset=offset
        )
        items = [_to_card(m) for m in movies]
        return _to_response(items, offset, limit)

    raise HTTPException(status_code=400, detail=f"unknown section key: {key}")


@router.get(
    "/home/section/popular_products",
    response_model=GoodsFeedResponse,
)
async def get_home_section_popular_products(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
) -> GoodsFeedResponse:
    """人気商品セクション (Goods) のページネーション用エンドポイント。

    動画 (Movie) ではなく商品 (Goods) を返すため、レスポンス型が FeedResponse とは
    異なる (items が GoodsCard)。それ以外のページネーション規約は /home/section と同じ。
    """
    fetch_limit = limit + 1
    items = await get_popular_products_all_time(
        db, limit=fetch_limit, offset=offset
    )
    has_next = len(items) > limit
    page = items[:limit]
    next_cursor = str(offset + limit) if has_next else None
    return GoodsFeedResponse(items=page, next_cursor=next_cursor)
