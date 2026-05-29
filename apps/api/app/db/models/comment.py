"""作品コメント モデル。

YouTube 風の 2 段スレッド (top-level + 返信) を扱う。

- ルートコメント: parent_id IS NULL
- 返信: parent_id がルートコメント (parent_id IS NULL のもの) を指す
- スレッドの深さは 2 段までに制限する (API レイヤでバリデート)
- ON DELETE CASCADE で親コメント削除時に返信もまとめて消える
- author_user_id NULL は将来的なゲスト/退会済みユーザーに備えた設計
  (現状はログイン必須のため常に非 NULL で挿入される)
- display_name_snapshot は投稿時点のユーザー表示名を保存しておくスナップショット。
  ユーザーが後で表示名を変更してもコメント上の表示は変えない。
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import ForeignKey, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Comment(Base):
    __tablename__ = "comments"
    __table_args__ = (
        # 動画別の新着順取得用。WHERE movie_id = ? ORDER BY created_at DESC を素早く返す。
        Index("ix_comments_movie_created", "movie_id", "created_at"),
        # スレッド展開時の返信一括取得用。WHERE parent_id IN (...) ORDER BY created_at。
        Index("ix_comments_parent_created", "parent_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(primary_key=True, default=lambda: str(uuid.uuid4()))
    movie_id: Mapped[str] = mapped_column(
        ForeignKey("movies.id", ondelete="CASCADE"), nullable=False
    )
    # 返信のときだけ非 NULL。ルートコメントを直接 / 間接に指す
    # (2 段制限なので親が返信であってはいけないが、参照整合性は API 層で担保)。
    parent_id: Mapped[str | None] = mapped_column(
        ForeignKey("comments.id", ondelete="CASCADE"), nullable=True
    )
    author_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 投稿時点のユーザー表示名スナップショット (32 文字上限)。
    # ユーザー未設定なら「名無しのユーザー」を保存する。
    display_name_snapshot: Mapped[str] = mapped_column(String(32), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        default=_utcnow_naive, server_default=func.now(), nullable=False
    )
