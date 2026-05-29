"""作品コメントエンドポイント。

- GET  /movies/{slug}/comments    : ログイン不要。movie の slug をキーに 2 段スレッドを返す
- POST /movies/{slug}/comments    : ログイン必須。トップレベル or 返信を投稿
- DELETE /comments/{comment_id}   : ログイン必須。自分のコメントのみ削除可
- GET  /me/display-name           : ログイン必須。表示名取得 (未設定なら「名無しのユーザー」)
- PUT  /me/display-name           : ログイン必須。表示名更新 (空 / None で「名無しのユーザー」)

2 段スレッド方針:
  - parent_id IS NULL のコメントを root として最新順
  - root コメントに対する返信 (parent_id = root.id) を作成日時の昇順でぶら下げる
  - 親が「返信」のコメントへの返信は受け付けない (= 親は必ず root)
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_user
from app.db.models.comment import Comment
from app.db.models.movie import Movie
from app.db.models.user import User
from app.db.session import get_db
from app.schemas.comment import (
    DEFAULT_DISPLAY_NAME,
    DISPLAY_NAME_MAX_LEN,
    CommentCreateBody,
    CommentListResponse,
    CommentOut,
    DisplayNameResponse,
    DisplayNameUpdateBody,
)

router = APIRouter()


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _resolved_display_name(user: User) -> str:
    """User.display_name を「名無しのユーザー」にフォールバックして整形する。"""
    name = (user.display_name or "").strip()
    if not name:
        return DEFAULT_DISPLAY_NAME
    return name[:DISPLAY_NAME_MAX_LEN]


def _to_comment_out(c: Comment, replies: list[Comment] | None = None) -> CommentOut:
    return CommentOut(
        id=c.id,
        parent_id=c.parent_id,
        author_user_id=c.author_user_id,
        # 投稿時点のスナップショットを表示。退会で snapshot が空ならフォールバック。
        display_name=c.display_name_snapshot or DEFAULT_DISPLAY_NAME,
        body=c.body,
        created_at=c.created_at,
        replies=[_to_comment_out(r) for r in (replies or [])],
    )


async def _resolve_movie_id(db: AsyncSession, slug: str) -> str:
    """slug → movie_id を引く。見つからなければ 404。"""
    result = await db.execute(select(Movie.id).where(Movie.slug == slug))
    movie_id = result.scalar_one_or_none()
    if movie_id is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Movie not found"
        )
    return movie_id


@router.get("/movies/{slug}/comments", response_model=CommentListResponse)
async def list_comments(
    db: Annotated[AsyncSession, Depends(get_db)],
    slug: str = Path(..., min_length=1),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> CommentListResponse:
    """指定作品のコメントを 2 段スレッド形式で返す。

    - root コメントは最新順 (created_at DESC) で limit/offset ページング
    - 各 root に対する返信は古い順 (created_at ASC) で全件埋め込む
    - total はその movie の **root コメント数** (フロントの「コメント N 件」表示用)
    """
    movie_id = await _resolve_movie_id(db, slug)

    # root コメント
    roots_q = (
        select(Comment)
        .where(Comment.movie_id == movie_id, Comment.parent_id.is_(None))
        .order_by(Comment.created_at.desc(), Comment.id.desc())
        .limit(limit)
        .offset(offset)
    )
    roots = (await db.execute(roots_q)).scalars().all()

    # root の総数 (ページネーション UI 用)
    total = (
        await db.execute(
            select(func.count(Comment.id)).where(
                Comment.movie_id == movie_id, Comment.parent_id.is_(None)
            )
        )
    ).scalar_one()

    items: list[CommentOut] = []
    if roots:
        root_ids = [r.id for r in roots]
        replies_q = (
            select(Comment)
            .where(Comment.parent_id.in_(root_ids))
            .order_by(Comment.created_at.asc(), Comment.id.asc())
        )
        all_replies = (await db.execute(replies_q)).scalars().all()
        replies_by_parent: dict[str, list[Comment]] = defaultdict(list)
        for r in all_replies:
            # parent_id が None の reply は仕様外。スキップして防衛的に。
            if r.parent_id is None:
                continue
            replies_by_parent[r.parent_id].append(r)
        for root in roots:
            items.append(_to_comment_out(root, replies_by_parent.get(root.id, [])))
    return CommentListResponse(items=items, total=int(total or 0))


@router.post(
    "/movies/{slug}/comments",
    response_model=CommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_comment(
    body: CommentCreateBody,
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    slug: str = Path(..., min_length=1),
) -> CommentOut:
    """コメント / 返信を作成する。

    返信の場合は body.parent_id でルートコメント (= parent_id IS NULL) を指定する。
    2 段制限のため、parent_id が「返信コメント」を指す場合は 400 を返す。
    """
    movie_id = await _resolve_movie_id(db, slug)

    text = body.body.strip()
    if not text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Comment body is empty",
        )

    if body.parent_id is not None:
        parent_q = select(Comment).where(
            Comment.id == body.parent_id, Comment.movie_id == movie_id
        )
        parent = (await db.execute(parent_q)).scalar_one_or_none()
        if parent is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Parent comment not found",
            )
        if parent.parent_id is not None:
            # 返信 (= parent_id 非 NULL) への返信は許可しない。
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Replies can only be attached to top-level comments",
            )

    comment = Comment(
        movie_id=movie_id,
        parent_id=body.parent_id,
        author_user_id=user.id,
        display_name_snapshot=_resolved_display_name(user),
        body=text,
        created_at=_utcnow_naive(),
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return _to_comment_out(comment, [])


@router.delete(
    "/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None
)
async def delete_comment(
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    comment_id: str = Path(..., min_length=1),
) -> None:
    """自分のコメントを削除する。返信は ON DELETE CASCADE で連動削除される。"""
    target = (
        await db.execute(select(Comment).where(Comment.id == comment_id))
    ).scalar_one_or_none()
    if target is None:
        # 既に消えているのは冪等扱いで 204 にする。
        return
    if target.author_user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Cannot delete others' comment"
        )
    await db.execute(delete(Comment).where(Comment.id == comment_id))
    await db.commit()


# ---------- 表示名 (display_name) ----------


@router.get("/me/display-name", response_model=DisplayNameResponse)
async def get_display_name(
    user: Annotated[User, Depends(require_user)],
) -> DisplayNameResponse:
    """ログイン中ユーザーの表示名を返す。未設定なら「名無しのユーザー」。"""
    return DisplayNameResponse(display_name=_resolved_display_name(user))


@router.put("/me/display-name", response_model=DisplayNameResponse)
async def put_display_name(
    body: DisplayNameUpdateBody,
    user: Annotated[User, Depends(require_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> DisplayNameResponse:
    """表示名を更新する。空文字 / None なら NULL に戻し「名無しのユーザー」表示にする。"""
    name = (body.display_name or "").strip()
    user.display_name = name[:DISPLAY_NAME_MAX_LEN] if name else None
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return DisplayNameResponse(display_name=_resolved_display_name(user))
