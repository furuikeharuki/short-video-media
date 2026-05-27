from pydantic import BaseModel

from app.schemas.actress import ActressCard
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


class HomeResponse(BaseModel):
    sections: list[HomeSection]
    # 追加: 既存の sections (=動画系) と並列で女優系セクションを返す。
    # クライアントは sections / actress_sections を別々に描画する。
    actress_sections: list[HomeActressSection] = []
