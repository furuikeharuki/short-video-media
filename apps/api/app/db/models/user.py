"""ユーザー・認証情報・ブックマーク・視聴履歴モデル。

設計方針:
- 個人情報 (メール / 名前 / アバター / アクセストークン) は一切DBに持たない。
- Identity.sub_hash は SHA-256(provider + ":" + sub + ":" + APP_USER_SALT) のハッシュ値のみ。
- 同一 User に複数 Identity (Twitter + Discord 等) を紐付けできる。
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def _utcnow_naive() -> datetime:
    """events と同じく TIMESTAMP WITHOUT TIME ZONE 用に naive UTC を返す。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(primary_key=True, default=lambda: str(uuid.uuid4()))
    created_at: Mapped[datetime] = mapped_column(
        default=_utcnow_naive,
        server_default=func.now(),
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        default=_utcnow_naive,
        server_default=func.now(),
    )

    identities: Mapped[list["Identity"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Identity(Base):
    __tablename__ = "identities"
    __table_args__ = (
        UniqueConstraint("provider", "sub_hash", name="uq_identity_provider_sub"),
    )

    id: Mapped[str] = mapped_column(primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # "twitter" / "discord"
    provider: Mapped[str] = mapped_column(String(32), index=True)
    # SHA-256(provider:sub:APP_USER_SALT) の hex (64 文字)
    sub_hash: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(
        default=_utcnow_naive, server_default=func.now()
    )

    user: Mapped[User] = relationship(back_populates="identities")


class Bookmark(Base):
    __tablename__ = "bookmarks"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    movie_id: Mapped[str] = mapped_column(
        ForeignKey("movies.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(
        default=_utcnow_naive, server_default=func.now(), index=True
    )


class ViewHistory(Base):
    __tablename__ = "view_histories"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    movie_id: Mapped[str] = mapped_column(
        ForeignKey("movies.id", ondelete="CASCADE"), primary_key=True
    )
    last_viewed_at: Mapped[datetime] = mapped_column(
        default=_utcnow_naive, server_default=func.now(), index=True
    )
    view_count: Mapped[int] = mapped_column(Integer, default=1, server_default="1")


class UserNgWord(Base):
    """ユーザー固有の NG ワード。

    検索 API は未指定時にこのテーブルを自動的に適用するため、ログインユーザーは
    各クライアントに同じ NG リストを設定し直さなくてもよい。
    user_id + word の複合 PK で重複を防ぐ。
    """

    __tablename__ = "user_ng_words"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    word: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        default=_utcnow_naive, server_default=func.now()
    )


class UserSearchPref(Base):
    """ユーザー固有の最後に適用した検索条件 (1 ユーザー 1 件)。

    フィルターのチップ・日付・ソートを JSON で保存しておき、検索結果ページを
    再訪したときに前回の絞り込みを自動復元する。NG ワードは UserNgWord
    に既に保存されているので含めない。
    """

    __tablename__ = "user_search_prefs"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # 中身は { q, genres, actresses, series_list, directors, makers,
    #         labels, date_from, date_to, sort } の JSON。
    # サーバ側ではバリデーションせずに通す (Web 側で URL に組み立てる構造と一致)。
    payload: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    updated_at: Mapped[datetime] = mapped_column(
        default=_utcnow_naive,
        server_default=func.now(),
        onupdate=_utcnow_naive,
    )
