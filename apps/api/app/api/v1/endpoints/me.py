"""ログイン中ユーザー向けエンドポイント (ブックマーク / 視聴履歴)。

すべて Authorization: Bearer <jwt> が必須 (require_user 依存)。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_user
from app.db.models.movie import Movie
from app.db.models.user import (
    Bookmark,
    User,
    UserNgWord,
    UserSearchPref,
    ViewHistory,
)
from app.db.session import get_db
from app.repositories.movie_repository import get_movies_by_ids
from app.schemas.movie import MovieCard
from app.services.feed_service import _to_card

router = APIRouter(prefix="/me")


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ---------- ブックマーク ----------


class BookmarkItem(BaseModel):
    movie: MovieCard
    created_at: datetime


class BookmarkListResponse(BaseModel):
    items: list[BookmarkItem]


class ToggleBody(BaseModel):
    movie_id: str


class BookmarkStateResponse(BaseModel):
    bookmarked: bool


@router.get("/bookmarks", response_model=BookmarkListResponse)
async def list_bookmarks(
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> BookmarkListResponse:
    """ブックマーク一覧。新しい順 (created_at DESC)。"""
    result = await db.execute(
        select(Bookmark)
        .where(Bookmark.user_id == user.id)
        .order_by(Bookmark.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    bookmarks = result.scalars().all()
    if not bookmarks:
        return BookmarkListResponse(items=[])

    movie_ids = [b.movie_id for b in bookmarks]
    movies = await get_movies_by_ids(db, movie_ids)
    items: list[BookmarkItem] = []
    for b in bookmarks:
        m = movies.get(b.movie_id)
        if m is None:
            continue  # 削除済み作品はスキップ
        items.append(BookmarkItem(movie=_to_card(m), created_at=b.created_at))
    return BookmarkListResponse(items=items)


@router.post("/bookmarks", response_model=BookmarkStateResponse)
async def add_bookmark(
    body: ToggleBody,
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> BookmarkStateResponse:
    """ブックマーク追加 (既にある場合は何もしない)。"""
    # 作品の存在チェック (非表示作品はブックマーク不可)
    exists = (
        await db.execute(
            select(Movie.id).where(
                Movie.id == body.movie_id, Movie.is_visible.is_(True)
            )
        )
    ).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Movie not found")

    stmt = (
        pg_insert(Bookmark)
        .values(user_id=user.id, movie_id=body.movie_id)
        .on_conflict_do_nothing(index_elements=["user_id", "movie_id"])
    )
    await db.execute(stmt)
    await db.commit()
    return BookmarkStateResponse(bookmarked=True)


@router.delete("/bookmarks", response_model=BookmarkStateResponse)
async def remove_bookmark(
    body: ToggleBody,
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> BookmarkStateResponse:
    """ブックマーク削除 (存在しなくてもエラーにしない)。"""
    await db.execute(
        delete(Bookmark).where(
            Bookmark.user_id == user.id, Bookmark.movie_id == body.movie_id
        )
    )
    await db.commit()
    return BookmarkStateResponse(bookmarked=False)


@router.get("/bookmarks/ids", response_model=list[str])
async def list_bookmark_ids(
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[str]:
    """ログイン中ユーザーのブックマーク movie_id を全件返す (フィード等で ❤ 状態判定用)。"""
    result = await db.execute(
        select(Bookmark.movie_id).where(Bookmark.user_id == user.id)
    )
    return [row[0] for row in result.all()]


# ---------- 視聴履歴 ----------


class ViewItem(BaseModel):
    movie: MovieCard
    last_viewed_at: datetime
    view_count: int


class ViewListResponse(BaseModel):
    items: list[ViewItem]


@router.post("/views", response_model=None, status_code=status.HTTP_204_NO_CONTENT)
async def record_view(
    body: ToggleBody,
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    """視聴を1件記録する。存在すれば view_count += 1 / last_viewed_at 更新。"""
    exists = (
        await db.execute(
            select(Movie.id).where(
                Movie.id == body.movie_id, Movie.is_visible.is_(True)
            )
        )
    ).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Movie not found")

    now = _utcnow_naive()
    stmt = (
        pg_insert(ViewHistory)
        .values(
            user_id=user.id,
            movie_id=body.movie_id,
            last_viewed_at=now,
            view_count=1,
        )
        .on_conflict_do_update(
            index_elements=["user_id", "movie_id"],
            set_={
                "last_viewed_at": now,
                "view_count": ViewHistory.view_count + 1,
            },
        )
    )
    await db.execute(stmt)
    await db.commit()


@router.get("/views", response_model=ViewListResponse)
async def list_views(
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> ViewListResponse:
    """視聴履歴。最新視聴日時の新しい順。"""
    result = await db.execute(
        select(ViewHistory)
        .where(ViewHistory.user_id == user.id)
        .order_by(ViewHistory.last_viewed_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = result.scalars().all()
    if not rows:
        return ViewListResponse(items=[])

    movie_ids = [r.movie_id for r in rows]
    movies = await get_movies_by_ids(db, movie_ids)
    items: list[ViewItem] = []
    for r in rows:
        m = movies.get(r.movie_id)
        if m is None:
            continue
        items.append(
            ViewItem(
                movie=_to_card(m),
                last_viewed_at=r.last_viewed_at,
                view_count=r.view_count,
            )
        )
    return ViewListResponse(items=items)


# ---------- NG ワード ----------


class NgWordsResponse(BaseModel):
    words: list[str]


class NgWordsUpdateBody(BaseModel):
    words: list[str]


def _normalize_ng_words(raw: list[str]) -> list[str]:
    """空白除去・空文字弾き・重複排除 (順序維持)・長さ上限 (64文字) を適用する。

    DB の word カラムが String(64) なので明示的に切り詰める。クライアントが
    巨大な配列を投げてきても暴走しないよう件数も制限する。
    """
    seen: set[str] = set()
    out: list[str] = []
    for w in raw:
        if not isinstance(w, str):
            continue
        w2 = w.strip()
        if not w2:
            continue
        if len(w2) > 64:
            w2 = w2[:64]
        if w2 in seen:
            continue
        seen.add(w2)
        out.append(w2)
        if len(out) >= 200:
            break
    return out


@router.get("/ng-words", response_model=NgWordsResponse)
async def list_ng_words(
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> NgWordsResponse:
    """ログイン中ユーザーの NG ワード一覧。新しく追加した順 (created_at DESC)。"""
    result = await db.execute(
        select(UserNgWord.word)
        .where(UserNgWord.user_id == user.id)
        .order_by(UserNgWord.created_at.desc(), UserNgWord.word)
    )
    return NgWordsResponse(words=[row[0] for row in result.all()])


@router.put("/ng-words", response_model=NgWordsResponse)
async def replace_ng_words(
    body: NgWordsUpdateBody,
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> NgWordsResponse:
    """NG ワード全置換。差分更新は煩雑なので「削除 → INSERT」する。"""
    words = _normalize_ng_words(body.words)
    await db.execute(delete(UserNgWord).where(UserNgWord.user_id == user.id))
    if words:
        await db.execute(
            UserNgWord.__table__.insert(),
            [{"user_id": user.id, "word": w} for w in words],
        )
    await db.commit()
    return NgWordsResponse(words=words)


# ---------- 検索条件の自動保存 ----------


class SearchPrefPayload(BaseModel):
    """最後に適用した検索条件。全フィールド optional。

    Web 側で URL クエリに復元する用途なので None を「未指定」として保持する。
    GET レスポンスでも PUT リクエストでも同じ構造を使う。
    """

    q: str | None = None
    genres: list[str] | None = None
    actresses: list[str] | None = None
    series_list: list[str] | None = None
    directors: list[str] | None = None
    makers: list[str] | None = None
    labels: list[str] | None = None
    ng_words: list[str] | None = None
    date_from: str | None = None
    date_to: str | None = None
    sort: str | None = None


@router.get("/search-prefs", response_model=SearchPrefPayload)
async def get_search_pref(
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> SearchPrefPayload:
    """検索条件を取得。未保存なら全フィールド None で返す。"""
    result = await db.execute(
        select(UserSearchPref.payload).where(UserSearchPref.user_id == user.id)
    )
    payload = result.scalar_one_or_none()
    if payload is None:
        return SearchPrefPayload()
    # 保存時の余分なキーは Pydantic が落としてくれる
    return SearchPrefPayload.model_validate(payload)


@router.put("/search-prefs", response_model=SearchPrefPayload)
async def put_search_pref(
    body: SearchPrefPayload,
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> SearchPrefPayload:
    """検索条件を全置換 (upsert)。

    None も保持する (`exclude_none=False`) ことで、フロントは PUT したのと
    同じ shape を GET で取り戻せる。
    """
    payload = body.model_dump(exclude_none=False)
    stmt = (
        pg_insert(UserSearchPref)
        .values(user_id=user.id, payload=payload)
        .on_conflict_do_update(
            index_elements=["user_id"],
            set_={"payload": payload, "updated_at": _utcnow_naive()},
        )
    )
    await db.execute(stmt)
    await db.commit()
    return body
