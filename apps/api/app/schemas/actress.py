from pydantic import BaseModel

from app.schemas.movie import MovieCard, PriceList


class ActressCard(BaseModel):
    """ホームの「人気女優」セクションなど、横スクロール一覧で使う軽量カード。"""
    id: int
    name: str
    slug: str | None = None
    thumbnail_url: str | None = None
    image_url_small: str | None = None
    image_url_large: str | None = None


class GoodsCard(BaseModel):
    """女優詳細ページの「関連商品」セクションで使うグッズ表示用カード"""
    id: str
    content_id: str | None = None
    title: str
    slug: str
    image_url_list: str | None = None
    image_url_large: str | None = None
    affiliate_url: str
    price_list: PriceList | None = None
    price_min: int | None = None
    review_count: int = 0
    review_average: float | None = None
    maker_name: str | None = None


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
    goods: list[GoodsCard] = []
