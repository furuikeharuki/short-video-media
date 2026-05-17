"""ホーム画面用の集約エンドポイント。
複数セクションを 1 リクエストで返す。
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.repositories.movie_repository import (
    get_movies_by_genre,
    get_new_release_movies,
    get_recent_release_movies,
    get_top_genres_by_movie_count,
)
from app.schemas.feed import FeedResponse
from app.schemas.home import HomeResponse, HomeSection
from app.services.feed_service import _to_card
from app.services.ranking_service import (
    get_popular_all_time,
    get_popular_search_genres,
    get_ranking,
)


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

    # 3. 人気 (全期間の総視聴回数順)
    popular_items = await get_popular_all_time(db, limit=section_limit)
    sections.append(
        HomeSection(
            key="popular",
            title="人気",
            subtitle="総視聴回数順",
            items=popular_items,
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

    return HomeResponse(sections=sections)


# section ごとの "もっと見る" ・ フィード継足し用エンドポイント。
# offset/limit を受け取り、同じ並び順で指定区間を返す。
# ランキング・人気は集計システム上 1 クエリで offset したりできず、
# offset+limit 件取ってサーバ側でスライスして返す。
# next_cursor は "要求 limit に達したかどうか" で判定する。
# - page が limit 件ぴったり返ったら "次がある可能性あり" として next_cursor を返す。
#   (そのとき実際には末尾だったケースは、クライアントが 1 回余計にフェッチして空を受け取るだけ)
# - page が limit 未満なら末尾確定として None を返す。
#
# 注意: サービス層で visible filter 等で間引かれる場合、中途のページで "limit 未満" になって
# 本来続くはずのスクロールが打ち止まるリスクがあるため、呼び出し側で余裕をもって
# 取り (fetch_size = offset + limit * 2 など) サービスが足りるなら "limit 件以上" を返せるようにしている。
async def _slice_response(
    items: list, offset: int, limit: int
) -> FeedResponse:
    page = items[offset : offset + limit]
    next_cursor = str(offset + limit) if len(page) >= limit else None
    return FeedResponse(items=page, next_cursor=next_cursor)


@router.get("/home/section", response_model=FeedResponse)
async def get_home_section(
    key: str = Query(..., min_length=1),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    genre: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> FeedResponse:
    """ホームセクションと同じ順番で、offset+limit の区間を返す。

    - key='popular'         : 総視聴回数順 (人気)
    - key='ranking_daily'   : デイリーランキング
    - key='ranking_weekly'  : 週間ランキング
    - key='ranking_monthly' : 月間ランキング
    - key='new'             : 本日配信開始 (最大1ページだけ、以降null)
    - key='recent'          : 新着 (直近1ヶ月、今日を除く)
    - key='genre'           : ジャンル絞り込み (必ず genre クエリを伴う)
    """
    # 広めに一括取得してサーバ側で slice するシンプル実装。
    # リポジトリ層で is_visible フィルタなどの間引きが起きても
    # "要求 limit 件をちゃんと返せる" よう余裕をもったサイズで取得する。
    # (limit * 2 と limit + 10 の大きい方。例: limit=21 → 42)
    # それでもなお間引かれて limit 未満しか返らない場合は、実質末尾とみなして
    # next_cursor=None となり、クライアントは継足しを停止する。
    fetch_size = max(offset + limit * 2, offset + limit + 10)

    if key == "popular":
        items = await get_popular_all_time(db, limit=fetch_size)
        return await _slice_response(items, offset, limit)

    if key == "ranking_daily":
        items = await get_ranking(db, period="daily", limit=fetch_size)
        return await _slice_response(items, offset, limit)

    if key == "ranking_weekly":
        items = await get_ranking(db, period="weekly", limit=fetch_size)
        return await _slice_response(items, offset, limit)

    if key == "ranking_monthly":
        items = await get_ranking(db, period="monthly", limit=fetch_size)
        return await _slice_response(items, offset, limit)

    if key == "new":
        # "本日配信開始" は本日分のみ表示したいため fallback_days=0。
        # 件数が少ないので fetch_size もそのまま　2ページ目以降は空になり、
        # クライアント側は next_cursor=null を見て継足しを止める。
        movies = await get_new_release_movies(db, limit=fetch_size, fallback_days=0)
        items = [_to_card(m) for m in movies]
        return await _slice_response(items, offset, limit)

    if key == "recent":
        movies = await get_recent_release_movies(db, days=30, limit=fetch_size)
        items = [_to_card(m) for m in movies]
        return await _slice_response(items, offset, limit)

    if key == "genre":
        if not genre:
            raise HTTPException(status_code=400, detail="genre query is required when key='genre'")
        movies = await get_movies_by_genre(db, genre_name=genre, limit=fetch_size)
        items = [_to_card(m) for m in movies]
        return await _slice_response(items, offset, limit)

    raise HTTPException(status_code=400, detail=f"unknown section key: {key}")
