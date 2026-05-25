import hashlib
import json
import random
from datetime import date
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import get_redis
from app.repositories.movie_repository import (
    get_all_movie_ids,
    get_movies_by_ids,
    get_movies_paginated,
)
from app.repositories.search_repository import get_advanced_movie_ids
from app.schemas.feed import FeedResponse
from app.schemas.movie import MovieCard, PriceList


SortKey = Literal["new", "popular", "rating", "views", "bookmarks"]

SHUFFLE_CACHE_TTL = 3600
MOVIES_CACHE_TTL  = 1800
SHUFFLE_KEY_PREFIX = "feed:shuffle:"
MOVIES_KEY_PREFIX  = "movies:data:"


def _to_card(movie) -> MovieCard:
    price_list = None
    if movie.price_list:
        price_list = PriceList.model_validate(movie.price_list)

    return MovieCard(
        id=str(movie.id),
        content_id=movie.content_id,
        title=movie.title,
        slug=movie.slug,
        image_url_list=movie.image_url_list,
        image_url_large=movie.image_url_large,
        affiliate_url=movie.affiliate_url,
        price_list=price_list,
        price_min=movie.price_min,
        review_count=movie.review_count or 0,
        review_average=float(movie.review_average) if movie.review_average else None,
        actresses=[a.name for a in movie.actresses],
        genres=[g.name for g in movie.genres],
        series_name=movie.series.name if movie.series else None,
    )


def _card_to_dict(card: MovieCard) -> dict:
    return card.model_dump()


def _adv_cache_key(seed: int, adv: dict) -> str:
    """advanced 条件入りシャッフル ID 一覧のキャッシュキー。

    キャッシュバスト用に条件 dict を sha1 でハッシュ化したものをキーに混ぜる。
    """
    payload = json.dumps(adv, sort_keys=True, default=str, ensure_ascii=False)
    h = hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]
    return f"{SHUFFLE_KEY_PREFIX}{seed}:adv:{h}"


async def _get_shuffled_ids(
    db: AsyncSession,
    seed: int,
    genres: list[str] | None = None,
) -> list[str]:
    redis = get_redis()
    genre_key = ",".join(sorted(genres)) if genres else "all"
    key = f"{SHUFFLE_KEY_PREFIX}{seed}:{genre_key}"

    if redis is not None:
        cached = await redis.get(key)
        if cached:
            return json.loads(cached)

    ids = await get_all_movie_ids(db, genres=genres)
    rng = random.Random(seed)
    rng.shuffle(ids)

    if redis is not None:
        await redis.set(key, json.dumps(ids), ex=SHUFFLE_CACHE_TTL)

    return ids


async def _get_advanced_shuffled_ids(
    db: AsyncSession,
    seed: int,
    *,
    q: str | None,
    genres: list[str],
    actresses: list[str],
    series_list: list[str],
    directors: list[str],
    makers: list[str],
    labels: list[str],
    ng_words: list[str],
    date_from: date | None,
    date_to: date | None,
    sort: SortKey | None = None,
) -> list[str]:
    """詳細検索条件にマッチする movie_id を返す (redis キャッシュ)。

    sort 未指定: 从来通り seed で shuffle して返す。
    sort 指定あり: shuffle せず、指定されたソート順 (検索結果と同じ ORDER BY)で返す。
    """
    adv_dict = {
        "q": q or "",
        "genres": sorted(genres),
        "actresses": sorted(actresses),
        "series_list": sorted(series_list),
        "directors": sorted(directors),
        "makers": sorted(makers),
        "labels": sorted(labels),
        "ng_words": sorted(ng_words),
        "date_from": date_from.isoformat() if date_from else "",
        "date_to": date_to.isoformat() if date_to else "",
        "sort": sort or "",
    }
    redis = get_redis()
    key = _adv_cache_key(seed, adv_dict)

    if redis is not None:
        cached = await redis.get(key)
        if cached:
            return json.loads(cached)

    ids = await get_advanced_movie_ids(
        db,
        q=q or None,
        genres=genres or None,
        actresses=actresses or None,
        series_list=series_list or None,
        directors=directors or None,
        makers=makers or None,
        labels=labels or None,
        ng_words=ng_words or None,
        date_from=date_from,
        date_to=date_to,
        sort=sort,
    )
    # sort 指定があるときは DB 側の ORDER BY をそのまま使う (= shuffle しない)。
    # 未指定のときだけ 従来通り seed で shuffle したランダム順フィードにする。
    if sort is None:
        rng = random.Random(seed)
        rng.shuffle(ids)

    if redis is not None:
        await redis.set(key, json.dumps(ids), ex=SHUFFLE_CACHE_TTL)

    return ids


async def _get_movies_with_cache(
    db: AsyncSession,
    page_ids: list[str],
) -> dict[str, MovieCard]:
    redis = get_redis()
    result: dict[str, MovieCard] = {}
    missing_ids: list[str] = []

    if redis is not None:
        for movie_id in page_ids:
            key = f"{MOVIES_KEY_PREFIX}{movie_id}"
            cached = await redis.get(key)
            if cached:
                data = json.loads(cached)
                result[movie_id] = MovieCard.model_validate(data)
            else:
                missing_ids.append(movie_id)
    else:
        missing_ids = page_ids

    if missing_ids:
        id_map = await get_movies_by_ids(db, missing_ids)
        for movie_id, movie in id_map.items():
            card = _to_card(movie)
            result[movie_id] = card
            if redis is not None:
                key = f"{MOVIES_KEY_PREFIX}{movie_id}"
                await redis.set(key, json.dumps(_card_to_dict(card)), ex=MOVIES_CACHE_TTL)

    return result


def _has_advanced_filter(
    *,
    q: str | None,
    actresses: list[str],
    series_list: list[str],
    directors: list[str],
    makers: list[str],
    labels: list[str],
    ng_words: list[str],
    date_from: date | None,
    date_to: date | None,
) -> bool:
    """advanced 経路に乗せるべきかどうか (genres 以外で条件が指定されているか)。

    genres は元々フィードでサポートしていたフィルターなので、これだけの場合は
    既存の `_get_shuffled_ids(seed, genres=...)` 経路をそのまま使うほうが速い
    (M:N ジャンル AND ではなく OR でいい既存挙動を維持する)。
    """
    return bool(
        (q and q.strip())
        or actresses
        or series_list
        or directors
        or makers
        or labels
        or ng_words
        or date_from is not None
        or date_to is not None
    )


async def get_feed_paginated(
    db: AsyncSession,
    offset: int = 0,
    limit: int = 20,
    seed: int | None = None,
    genres: list[str] | None = None,
    *,
    q: str | None = None,
    actresses: list[str] | None = None,
    series_list: list[str] | None = None,
    directors: list[str] | None = None,
    makers: list[str] | None = None,
    labels: list[str] | None = None,
    ng_words: list[str] | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    sort: SortKey | None = None,
) -> FeedResponse:
    genres_norm = genres or []
    actresses_norm = actresses or []
    series_list_norm = series_list or []
    directors_norm = directors or []
    makers_norm = makers or []
    labels_norm = labels or []
    ng_words_norm = ng_words or []

    advanced = _has_advanced_filter(
        q=q,
        actresses=actresses_norm,
        series_list=series_list_norm,
        directors=directors_norm,
        makers=makers_norm,
        labels=labels_norm,
        ng_words=ng_words_norm,
        date_from=date_from,
        date_to=date_to,
    )
    # sort が指定されたときも advanced 経路に乗せる (ORDER BY を DB 側で適用したいため)。
    # genres ジャンルだけ指定 + sort 指定のケースも advanced 経路に完全一致 AND で乗せればいい。
    if sort is not None:
        advanced = True

    # advanced 経路: 必ず seed (= shuffle) が必要。seed 無しなら 0 で固定し、安定した順序にする。
    if advanced:
        effective_seed = seed if seed is not None else 0
        shuffled_ids = await _get_advanced_shuffled_ids(
            db,
            effective_seed,
            q=q,
            # advanced 経路は genres も AND 条件 (`advanced_search_movies`) に乗せる
            genres=genres_norm,
            actresses=actresses_norm,
            series_list=series_list_norm,
            directors=directors_norm,
            makers=makers_norm,
            labels=labels_norm,
            ng_words=ng_words_norm,
            date_from=date_from,
            date_to=date_to,
            sort=sort,
        )
        total = len(shuffled_ids)
        page_ids = shuffled_ids[offset: offset + limit]
        if not page_ids:
            return FeedResponse(items=[], next_cursor=None, total=total)

        card_map = await _get_movies_with_cache(db, page_ids)
        items = [card_map[i] for i in page_ids if i in card_map]
        next_offset = offset + limit
        next_cursor = str(next_offset) if next_offset < total else None
        return FeedResponse(items=items, next_cursor=next_cursor, total=total)

    # 既存ルート (genres 単独 OR / または無条件) はそのまま
    if seed is not None:
        shuffled_ids = await _get_shuffled_ids(db, seed, genres=genres_norm or None)
        total = len(shuffled_ids)
        page_ids = shuffled_ids[offset: offset + limit]

        if not page_ids:
            return FeedResponse(items=[], next_cursor=None, total=total)

        card_map = await _get_movies_with_cache(db, page_ids)
        items = [card_map[i] for i in page_ids if i in card_map]

        next_offset = offset + limit
        next_cursor = str(next_offset) if next_offset < total else None
        return FeedResponse(items=items, next_cursor=next_cursor, total=total)

    movies, total = await get_movies_paginated(
        db, offset=offset, limit=limit, genres=genres_norm or None
    )
    items = [_to_card(m) for m in movies]
    next_offset = offset + limit
    next_cursor = str(next_offset) if next_offset < total else None
    return FeedResponse(items=items, next_cursor=next_cursor, total=total)
