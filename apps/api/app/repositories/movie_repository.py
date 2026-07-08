from datetime import date, timedelta

from sqlalchemy import desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.movie import Movie
from app.db.models.genre import Genre
from app.db.models.movie import MovieGenre


async def get_movie_video_url_targets(
    db: AsyncSession,
    *,
    only_missing: bool = True,
    limit: int | None = None,
) -> list[tuple[str, str]]:
    """sync_video_urls ジョブ向けに (id, content_id) の一覧を返す。

    - 可視 (is_visible=True) かつ content_id を持つ作品だけを対象にする
      (content_id が無いと resolver を呼べない)。
    - `only_missing=True` (既定) なら、まだ MP4 URL を保存していない
      (sample_mp4_url / sample_low_mp4_url / sample_high_mp4_url のいずれかが NULL)
      作品だけを返す。差分実行 (毎回の cron / 初回バックフィル) 用。
    - `only_missing=False` なら全対象を返す。月次のトークン貼り直し (full refresh) 用。

    並び順は「初回再生で当たりやすい人気作から埋める」ため review_count 降順。
    ORM オブジェクト (selectin relationship) を読むと OOM しやすいので、
    id / content_id の 2 カラムだけを返す。
    """
    stmt = (
        select(Movie.id, Movie.content_id)
        .where(Movie.is_visible.is_(True))
        .where(Movie.content_id.is_not(None))
    )
    if only_missing:
        stmt = stmt.where(
            or_(
                Movie.sample_mp4_url.is_(None),
                Movie.sample_low_mp4_url.is_(None),
                Movie.sample_high_mp4_url.is_(None),
            )
        )
    stmt = stmt.order_by(desc(Movie.review_count), desc(Movie.primary_date), Movie.id)
    if limit is not None:
        stmt = stmt.limit(limit)
    result = await db.execute(stmt)
    return [(mid, cid) for mid, cid in result.all() if cid]


async def get_movie_by_slug(db: AsyncSession, slug: str) -> Movie | None:
    result = await db.execute(
        select(Movie).where(Movie.slug == slug, Movie.is_visible.is_(True))
    )
    return result.scalar_one_or_none()


async def get_all_movie_ids(db: AsyncSession, genres: list[str] | None = None) -> list[str]:
    """全IDを取得。genresが指定された場合はAND条件で絞り込む。"""
    if genres:
        # AND: 各ジャンルをすべて持つ作品のみ
        query = (
            select(Movie.id)
            .join(Movie.genres)
            .where(Movie.is_visible.is_(True), Genre.name.in_(genres))
            .group_by(Movie.id)
            .having(func.count(Genre.id.distinct()) == len(genres))
            .order_by(Movie.id)
        )
    else:
        query = (
            select(Movie.id)
            .where(Movie.is_visible.is_(True))
            .order_by(Movie.id)
        )
    result = await db.execute(query)
    return list(result.scalars().all())


async def get_movies_by_ids(db: AsyncSession, ids: list[str]) -> dict[str, Movie]:
    """指定IDの作品を一括取得し、id -> Movie の dict で返す。"""
    if not ids:
        return {}
    result = await db.execute(
        select(Movie).where(Movie.id.in_(ids), Movie.is_visible.is_(True))
    )
    movies = result.scalars().all()
    return {m.id: m for m in movies}


async def get_resolve_warm_content_ids(
    db: AsyncSession,
    limit: int = 500,
) -> list[str]:
    """事前 resolve job 向けに「温める価値が高い順」の content_id を返す。

    フィードは shuffle 順だが、初回再生で当たりやすいのは人気作 (review_count
    が多い作品) なので、可視作品をレビュー数の多い順に並べて上位 N 件を返す。
    content_id を持たない作品 (= resolver を呼べない) は除外する。
    """
    query = (
        select(Movie.content_id)
        .where(Movie.is_visible.is_(True))
        .where(Movie.content_id.is_not(None))
        .order_by(desc(Movie.review_count), desc(Movie.primary_date))
        .limit(limit)
    )
    result = await db.execute(query)
    return [cid for cid in result.scalars().all() if cid]


async def get_movies_paginated(
    db: AsyncSession,
    offset: int = 0,
    limit: int = 20,
    genres: list[str] | None = None,
) -> tuple[list[Movie], int]:
    if genres:
        # AND: 各ジャンルをすべて持つ作品のみ
        subq = (
            select(Movie.id)
            .join(Movie.genres)
            .where(Movie.is_visible.is_(True), Genre.name.in_(genres))
            .group_by(Movie.id)
            .having(func.count(Genre.id.distinct()) == len(genres))
            .subquery()
        )
        base_query = select(Movie).where(Movie.id.in_(select(subq)))
        count_query = select(func.count()).select_from(subq)
    else:
        base_query = select(Movie).where(Movie.is_visible.is_(True))
        count_query = (
            select(func.count())
            .select_from(Movie)
            .where(Movie.is_visible.is_(True))
        )

    count_result = await db.execute(count_query)
    total = count_result.scalar_one()

    query = base_query.order_by(Movie.id).offset(offset).limit(limit)
    result = await db.execute(query)
    return list(result.scalars().all()), total


async def get_movies_by_slugs_ordered(
    db: AsyncSession,
    slugs: list[str],
) -> list[Movie]:
    """slug リストの順番を保ったまま作品を返す。"""
    if not slugs:
        return []
    result = await db.execute(
        select(Movie).where(Movie.slug.in_(slugs), Movie.is_visible.is_(True))
    )
    movies = list(result.scalars().unique().all())
    order_index = {s: i for i, s in enumerate(slugs)}
    movies.sort(key=lambda m: order_index.get(m.slug, 1 << 30))
    return movies


async def get_new_release_movies(
    db: AsyncSession,
    *,
    on_date: date | None = None,
    fallback_days: int = 7,
    limit: int = 20,
    offset: int = 0,
) -> list[Movie]:
    """本日配信開始作品。今日付の primary_date を優先し、
    ゼロ件なら直近 fallback_days 日でフォールバック。

    offset/limit は SQL レベルで適用。主クエリとフォールバッククエリを
    スイッチして使う仕様はそのままだが、キーセットがずれるのを防ぐため
    「主クエリで 1 件でもひったら その offset/limit をそのまま適用し、
    一件もなければ フォールバック側で offset/limit を適用」とする。
    """
    target = on_date or date.today()
    stmt = (
        select(Movie)
        .where(
            Movie.is_visible.is_(True),
            Movie.primary_date == target,
        )
        .order_by(desc(Movie.review_count), Movie.id)
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    movies = list(result.scalars().unique().all())
    if movies:
        return movies

    # offset が 0 より大きい = 主クエリで見せる件数を超えている。
    # 今日付の件数だけを SQL で数えて、フォールバックに進むときは
    # offset から「今日付の全件数」を差し引いて計算し直す。
    if offset > 0:
        count_stmt = select(func.count(Movie.id)).where(
            Movie.is_visible.is_(True),
            Movie.primary_date == target,
        )
        today_total = int((await db.execute(count_stmt)).scalar_one())
        fb_offset = max(0, offset - today_total)
    else:
        fb_offset = 0

    # フォールバック: 直近 fallback_days 日の配信を返す
    since = target - timedelta(days=fallback_days)
    stmt2 = (
        select(Movie)
        .where(
            Movie.is_visible.is_(True),
            Movie.primary_date.is_not(None),
            Movie.primary_date >= since,
            Movie.primary_date <= target,
        )
        # ページネーション安定化のため二次キーに Movie.id を追加。
        .order_by(desc(Movie.primary_date), desc(Movie.review_count), Movie.id)
        .offset(fb_offset)
        .limit(limit)
    )
    result2 = await db.execute(stmt2)
    return list(result2.scalars().unique().all())


async def get_recent_release_movies(
    db: AsyncSession,
    *,
    today: date | None = None,
    days: int = 30,
    limit: int = 20,
    offset: int = 0,
) -> list[Movie]:
    """「新着」セクション: 今日を除いた直近 days 日以内に配信開始された作品を、
    primary_date 降順 (新しいものが上) で SQL OFFSET/LIMIT で返す。
    """
    t = today or date.today()
    since = t - timedelta(days=days)
    stmt = (
        select(Movie)
        .where(
            Movie.is_visible.is_(True),
            Movie.primary_date.is_not(None),
            Movie.primary_date >= since,
            Movie.primary_date < t,  # 今日を除く
        )
        .order_by(desc(Movie.primary_date), desc(Movie.review_count), Movie.id)
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().unique().all())


async def get_movies_by_genre(
    db: AsyncSession,
    *,
    genre_name: str,
    limit: int = 20,
    offset: int = 0,
) -> list[Movie]:
    """指定ジャンルを含む作品を人気順 (review_count) で SQL OFFSET/LIMIT で返す。"""
    stmt = (
        select(Movie)
        .join(Movie.genres)
        .where(
            Movie.is_visible.is_(True),
            Genre.name == genre_name,
        )
        .order_by(desc(Movie.review_count), Movie.id)
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().unique().all())


async def get_fallback_ranking_movies(
    db: AsyncSession,
    *,
    limit: int = 20,
    window_days: int | None = None,
    offset: int = 0,
) -> list[Movie]:
    """イベントデータが不足しているときの代替ランキング。

    window_days を指定すると、直近 N 日に配信開始 (primary_date) された
    作品の中で review_count 降順を返す。
    ヒット件数が足りない場合は、全体の review_count 降順で補充する。

    offset は "window + 補充の連結した仸ストリーム上での位置"。
    データ量がどれだけ広がっても OFFSET + LIMIT しか SQL を抓たないように、
    各ステップで COUNT(*) を求めて offset を振り分ける。
    """
    movies: list[Movie] = []
    seen_ids: set[str] = set()

    if window_days is not None and window_days > 0:
        since = date.today() - timedelta(days=window_days)
        where_window = (
            Movie.is_visible.is_(True),
            Movie.primary_date.is_not(None),
            Movie.primary_date >= since,
        )
        # window クエリの総件数を求めて、offset を window/補充に振り分ける
        window_total = int(
            (await db.execute(select(func.count(Movie.id)).where(*where_window))).scalar_one()
        )
        if offset < window_total:
            stmt_window = (
                select(Movie)
                .where(*where_window)
                .order_by(
                    desc(Movie.review_count), desc(Movie.review_average), Movie.id
                )
                .offset(offset)
                .limit(limit)
            )
            result = await db.execute(stmt_window)
            for m in result.scalars().unique().all():
                if m.id not in seen_ids:
                    movies.append(m)
                    seen_ids.add(m.id)
            fb_offset = 0  # window で offset を消化した
        else:
            fb_offset = offset - window_total
    else:
        fb_offset = offset

    if len(movies) >= limit:
        return movies[:limit]

    # 補充: 全体の review_count 降順
    # window で取れた分を除いた残りを取り、重複を選んで取り除く。
    # SQL OFFSET は window クエリとは独立のストリームの中で適用されるため、
    # 重複除去で閐認たる件数を加望して多めに取る (limit の 2 倍)。
    need = limit - len(movies)
    stmt = (
        select(Movie)
        .where(Movie.is_visible.is_(True))
        .order_by(desc(Movie.review_count), desc(Movie.review_average), Movie.id)
        .offset(fb_offset)
        .limit(need * 2)
    )
    result = await db.execute(stmt)
    for m in result.scalars().unique().all():
        if len(movies) >= limit:
            break
        if m.id in seen_ids:
            continue
        movies.append(m)
        seen_ids.add(m.id)
    return movies[:limit]


async def get_top_genres_by_movie_count(
    db: AsyncSession,
    *,
    limit: int = 10,
    exclude: set[str] | None = None,
) -> list[str]:
    """表示可能 (is_visible=True) な作品を多く含む genre 名を limit 件返す。"""
    stmt = (
        select(Genre.name, func.count(MovieGenre.movie_id).label("c"))
        .join(MovieGenre, MovieGenre.genre_id == Genre.id)
        .join(Movie, Movie.id == MovieGenre.movie_id)
        .where(Movie.is_visible.is_(True))
        .group_by(Genre.name)
        .order_by(desc("c"))
        .limit(limit * 3)  # 除外後 limit 件残る余裕
    )
    result = await db.execute(stmt)
    out: list[str] = []
    for name, _ in result.all():
        if exclude and name in exclude:
            continue
        out.append(name)
        if len(out) >= limit:
            break
    return out
