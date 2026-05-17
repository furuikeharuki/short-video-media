from pydantic import BaseModel, Field


class EventCreate(BaseModel):
    """クライアントから送られてくるイベントログ。"""
    # view / play / detail_click / affiliate_click / search
    event_type: str = Field(..., min_length=1, max_length=32)
    slug: str | None = Field(default=None, max_length=255)
    title: str | None = Field(default=None, max_length=512)
    affiliate_url: str | None = Field(default=None, max_length=1024)
    next_path: str | None = Field(default=None, max_length=512)
    search_query: str | None = Field(default=None, max_length=255)


class EventAck(BaseModel):
    ok: bool = True
