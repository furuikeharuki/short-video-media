import uuid
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Event(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(primary_key=True, default=lambda: str(uuid.uuid4()))
    event_type: Mapped[str] = mapped_column(index=True)  # view / detail_click / affiliate_click
    slug: Mapped[str | None] = mapped_column(index=True)
    title: Mapped[str | None]
    affiliate_url: Mapped[str | None]
    next_path: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
    )
