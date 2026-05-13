from pydantic import BaseModel


class PriceList(BaseModel):
    """FANZAの価格体系。各キーは存在しない場合がある。"""
    list_price: int | None = None      # 定価
    sale_price: int | None = None      # セール価格
    rental_price: int | None = None    # レンタル価格
    delivery_price: int | None = None  # 配信価格


class MovieCard(BaseModel):
    """フィード・一覧表示用（軽量）"""
    id: str
    content_id: str | None = None
    title: str
    slug: str
    image_url_list: str | None = None
    image_url_large: str | None = None
    sample_movie_url: str | None = None
    affiliate_url: str
    price_list: PriceList | None = None
    price_min: int | None = None
    review_count: int = 0
    review_average: float | None = None
    actresses: list[str] = []
    genres: list[str] = []
    series_name: str | None = None


class MovieDetail(BaseModel):
    """作品詳細ページ用"""
    id: str
    content_id: str | None = None
    product_id: str | None = None
    maker_product: str | None = None
    title: str
    slug: str
    description: str = ""
    volume: int | None = None
    image_url_list: str | None = None
    image_url_large: str | None = None
    sample_movie_url: str | None = None
    sample_embed_url: str | None = None
    affiliate_url: str
    price_list: PriceList | None = None
    price_min: int | None = None
    release_date: str | None = None
    delivery_date: str | None = None
    rental_start_date: str | None = None
    primary_date: str | None = None
    review_count: int = 0
    review_average: float | None = None
    director_name: str | None = None
    label_name: str | None = None
    maker_name: str | None = None
    actresses: list[str] = []
    genres: list[str] = []
    series_name: str | None = None
