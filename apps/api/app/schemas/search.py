from pydantic import BaseModel
from app.schemas.movie import MovieCard


class SearchResponse(BaseModel):
    """検索結果を limit/offset でページングして返すレスポンス。

    - items: 現ページの作品リスト (最大 limit 件)
    - total: 検索ヒットの総件数 (ページングしても全体値を返す)
    - next_cursor: 次ページの offset (文字列)。末尾に達したら null。
    """

    items: list[MovieCard]
    total: int
    next_cursor: str | None = None
