from pydantic import BaseModel, field_validator


def _ensure_https(url: str | None) -> str | None:
    """画像・メディア URL の `http://` を `https://` に揃える。

    DMM 画像 CDN (pics.dmm.co.jp) は HTTPS でも 200 を返すが、
    affiliate API のレスポンスや既存 DB レコードに `http://` が残っているケースが
    あり、HTTPS ページから読むとブラウザが Mixed Content として upgrade or block する。
    レスポンス境界で一律に正規化して、フロント側で再現できない不整合を出さないようにする。
    """
    if not url:
        return url
    if url.startswith("http://"):
        return "https://" + url[len("http://") :]
    return url


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
    affiliate_url: str
    price_list: PriceList | None = None
    price_min: int | None = None
    review_count: int = 0
    review_average: float | None = None
    actresses: list[str] = []
    genres: list[str] = []
    series_name: str | None = None

    @field_validator("image_url_list", "image_url_large", mode="before")
    @classmethod
    def _upgrade_image_https(cls, v: str | None) -> str | None:
        return _ensure_https(v)


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
    # 25% 以上再生に到達したユニーク feed_session 数 (watch_count, canonical 定義)。
    # interaction_events から都度集計。値が無い (= 集計不能) ケースは None。
    # SEO 用 VideoObject.interactionStatistic はフロント側で None/0 のときは出さない。
    watch_count: int | None = None

    @field_validator(
        "image_url_list", "image_url_large", "sample_embed_url", mode="before"
    )
    @classmethod
    def _upgrade_media_https(cls, v: str | None) -> str | None:
        return _ensure_https(v)
