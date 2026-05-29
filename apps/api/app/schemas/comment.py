"""コメント API スキーマ。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

# 「名無しのユーザー」: display_name 未設定ユーザーの公開表示名。
# api 側で投稿時に snapshot に書き込み、フロントへの返却時にも同じ文字列を使う。
DEFAULT_DISPLAY_NAME = "名無しのユーザー"

# 上限。User.display_name (String(32)) と Comment.display_name_snapshot (String(32))
# の両方に合わせる。
DISPLAY_NAME_MAX_LEN = 32
# コメント本文の最大長。長文 SPAM を抑止する保護値。
COMMENT_BODY_MAX_LEN = 2000


class CommentOut(BaseModel):
    id: str
    parent_id: str | None
    author_user_id: str | None
    display_name: str
    body: str
    created_at: datetime
    # ルートコメントだけ返信を埋め込む (2 段スレッド)。
    # 返信側 CommentOut の replies は常に [] にして、無限スレッド化させない。
    replies: list["CommentOut"] = Field(default_factory=list)


CommentOut.model_rebuild()


class CommentListResponse(BaseModel):
    items: list[CommentOut]
    total: int


class CommentCreateBody(BaseModel):
    body: str = Field(..., min_length=1, max_length=COMMENT_BODY_MAX_LEN)
    parent_id: str | None = None


class DisplayNameResponse(BaseModel):
    display_name: str


class DisplayNameUpdateBody(BaseModel):
    # 空文字 / None で「名無しのユーザー」にリセット。
    display_name: str | None = Field(default=None, max_length=DISPLAY_NAME_MAX_LEN)
