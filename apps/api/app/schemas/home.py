from pydantic import BaseModel

from app.schemas.actress import ActressCard, GoodsCard
from app.schemas.movie import MovieCard


class HomeSection(BaseModel):
    """既存の動画系セクション。items は MovieCard。"""
    key: str
    title: str
    subtitle: str | None = None
    genre: str | None = None
    items: list[MovieCard]


class HomeActressSection(BaseModel):
    """女優系セクション (人気女優など)。items は ActressCard。"""
    key: str
    title: str
    subtitle: str | None = None
    items: list[ActressCard]


class HomeGoodsSection(BaseModel):
    """商品系セクション (人気商品など)。items は GoodsCard。

    動画 (Movie) と商品 (Goods) はテーブルが別なので、人気商品セクションを
    sections (=MovieCard) と一緒くたにせず、専用フィールドで返す。
    """
    key: str
    title: str
    subtitle: str | None = None
    items: list[GoodsCard]


class HomeResponse(BaseModel):
    sections: list[HomeSection]
    # 追加: 既存の sections (=動画系) と並列で女優系セクションを返す。
    # クライアントは sections / actress_sections を別々に描画する。
    actress_sections: list[HomeActressSection] = []
    # 追加: 商品系セクション (人気商品など)。MovieCard と GoodsCard は
    # フィールド構成が違うので sections と分離する。
    goods_sections: list[HomeGoodsSection] = []
