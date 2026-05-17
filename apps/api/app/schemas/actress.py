from pydantic import BaseModel

from app.schemas.movie import MovieCard


class ActressProfile(BaseModel):
    """女優プロフィール (DMM 女優検索 API 由来)"""
    id: int
    name: str
    slug: str | None = None
    ruby: str | None = None
    thumbnail_url: str | None = None
    image_url_small: str | None = None
    image_url_large: str | None = None

    # スリーサイズ・身体情報
    bust: int | None = None
    cup: str | None = None
    waist: int | None = None
    hip: int | None = None
    height: int | None = None

    # その他プロフィール
    birthday: str | None = None
    blood_type: str | None = None
    hobby: str | None = None
    prefectures: str | None = None

    # 外部リンク
    dmm_list_url: str | None = None


class ActressStats(BaseModel):
    """女優の出演作品集計"""
    movie_count: int = 0
    total_review_count: int = 0
    average_review: float | None = None
    top_genres: list[str] = []
    top_makers: list[str] = []


class ActressDetail(BaseModel):
    """女優詳細ページ全体レスポンス"""
    profile: ActressProfile
    stats: ActressStats
    movies: list[MovieCard] = []
