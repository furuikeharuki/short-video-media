import uuid
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Event(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(primary_key=True, default=lambda: str(uuid.uuid4()))
    # view / play / detail_click / affiliate_click / search
    event_type: Mapped[str] = mapped_column(index=True)
    slug: Mapped[str | None] = mapped_column(index=True)
    title: Mapped[str | None]
    affiliate_url: Mapped[str | None]
    next_path: Mapped[str | None]
    # search イベント用。ユーザーが検索ボックスに入れたタグ名 / クエリ。
    search_query: Mapped[str | None] = mapped_column(index=True)
    # カラムは TIMESTAMP WITHOUT TIME ZONE (naive UTC)。
    # tz-aware の datetime を渡すと asyncpg が型不一致で DataError を投げるため、
    # default は naive UTC で返す。
    created_at: Mapped[datetime] = mapped_column(
        default=lambda: datetime.now(timezone.utc).replace(tzinfo=None),
        server_default=func.now(),
        index=True,
    )
