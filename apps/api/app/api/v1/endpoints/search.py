from __future__ import annotations

from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_optional_user
from app.db.models.user import User, UserNgWord
from app.db.session import get_db
from app.repositories.search_repository import suggest_field_values
from app.schemas.search import SearchResponse
from app.services.search_service import (
    advanced_search,
    search,
    search_by_exact_field,
)

router = APIRouter()


SortKey = Literal["new", "popular", "rating", "views", "bookmarks"]
SuggestField = Literal["actress", "series", "director", "maker", "label", "genre"]


class SuggestResponse(BaseModel):
    """詳細検索パネルのテキスト入力サジェスト用レスポンス。

    候補名のリストのみ。使用頻度 (件数) はクライアントに必須ではないので返さない。
    """

    items: list[str]


def _is_advanced_request(
    *,
    genres: list[str],
    actresses: list[str],
    series_list: list[str],
    directors: list[str],
    makers: list[str],
    labels: list[str],
    date_from: date | None,
    date_to: date | None,
    sort: SortKey,
    ng_words: list[str],
) -> bool:
    """新パラメータが 1 つでも指定されていれば advanced ルートに乗せる判定。

    sort はデフォルトが "new" なので、明示的に変更されていないと advanced 扱いに
    しないよう、ここでは sort 単体ではトリガーしない (q のみで sort=new と同じ意味)。
    sort != "new" の時は advanced を意図しているとみなす。
    """
    return bool(
        genres
        or actresses
        or series_list
        or directors
        or makers
        or labels
        or date_from
        or date_to
        or ng_words
        or sort != "new"
    )


@router.get("/search", response_model=SearchResponse)
async def search_movies(
    q: str | None = Query(default=None, description="検索ワード (部分一致)"),
    director: str | None = Query(default=None, description="監督名 (完全一致)"),
    maker: str | None = Query(default=None, description="メーカー名 (完全一致)"),
    label: str | None = Query(default=None, description="レーベル名 (完全一致)"),
    series: str | None = Query(default=None, description="シリーズ名 (完全一致)"),
    # ---- advanced search 追加パラメータ ----
    genres: list[str] = Query(
        default_factory=list, description="ジャンル名 (AND)。複数指定可"
    ),
    actresses: list[str] = Query(
        default_factory=list, description="女優名 (AND)。複数指定可"
    ),
    series_list: list[str] = Query(
        default_factory=list, description="シリーズ名 (OR)。複数指定可"
    ),
    directors: list[str] = Query(
        default_factory=list, description="監督名 (OR)。複数指定可"
    ),
    makers: list[str] = Query(
        default_factory=list, description="メーカー名 (OR)。複数指定可"
    ),
    labels: list[str] = Query(
        default_factory=list, description="レーベル名 (OR)。複数指定可"
    ),
    date_from: date | None = Query(default=None, description="配信日 >= date_from"),
    date_to: date | None = Query(default=None, description="配信日 <= date_to"),
    sort: SortKey = Query(default="new", description="並び順"),
    ng_words: list[str] = Query(
        default_factory=list,
        description="NG ワード (タイトル等に含む作品を除外)。クライアントから明示指定された場合は DB の値より優先",
    ),
    offset: int = Query(default=0, ge=0, description="取得開始位置 (ページング)"),
    limit: int = Query(default=20, ge=1, le=100, description="1ページの件数"),
    user: Annotated[User | None, Depends(get_optional_user)] = None,
    db: AsyncSession = Depends(get_db),
) -> SearchResponse:
    # 1) 単一の完全一致パラメータ (director/maker/label/series) が指定されている、
    #    かつ advanced パラメータが指定されていない時のみ、後方互換の完全一致ルートを使う。
    is_advanced = _is_advanced_request(
        genres=genres,
        actresses=actresses,
        series_list=series_list,
        directors=directors,
        makers=makers,
        labels=labels,
        date_from=date_from,
        date_to=date_to,
        sort=sort,
        ng_words=ng_words,
    )

    if (director or maker or label or series) and not is_advanced:
        return await search_by_exact_field(
            db,
            director=director,
            maker=maker,
            label=label,
            series=series,
            limit=limit,
            offset=offset,
        )

    # 2) advanced 系のパラメータが何も指定されていない、かつ q だけの場合は
    #    既存の単純全文検索ルートを使う (テスト互換のため)。
    if not is_advanced and not (director or maker or label or series):
        if not q:
            raise HTTPException(
                status_code=400,
                detail="q, director, maker, label, series のいずれかを指定してください",
            )
        return await search(db, q, limit=limit, offset=offset)

    # 3) advanced ルート。
    # NG ワードはクエリで明示指定があればそれを使う (ログイン状態問わず)。
    # 指定がなくログイン中ならサーバ保存の NG を自動適用。
    effective_ng = list(ng_words)
    if not effective_ng and user is not None:
        result = await db.execute(
            select(UserNgWord.word).where(UserNgWord.user_id == user.id)
        )
        effective_ng = [row[0] for row in result.all()]

    # 単一版 (director/maker/label/series) も後方互換で advanced 側にマージする
    merged_directors = list(directors)
    if director and director not in merged_directors:
        merged_directors.append(director)
    merged_makers = list(makers)
    if maker and maker not in merged_makers:
        merged_makers.append(maker)
    merged_labels = list(labels)
    if label and label not in merged_labels:
        merged_labels.append(label)
    merged_series = list(series_list)
    if series and series not in merged_series:
        merged_series.append(series)

    return await advanced_search(
        db,
        q=q,
        genres=genres,
        actresses=actresses,
        series_list=merged_series,
        directors=merged_directors,
        makers=merged_makers,
        labels=merged_labels,
        date_from=date_from,
        date_to=date_to,
        ng_words=effective_ng,
        sort=sort,
        limit=limit,
        offset=offset,
    )


@router.get("/search/suggest", response_model=SuggestResponse)
async def search_suggest(
    field: SuggestField = Query(..., description="サジェスト対象のフィールド"),
    q: str = Query(default="", description="部分一致 (case-insensitive)。空なら全件対象"),
    limit: int = Query(default=10, ge=1, le=50, description="返す件数"),
    db: AsyncSession = Depends(get_db),
) -> SuggestResponse:
    """詳細検索パネルの入力サジェスト。

    使用頻度 (= その値を持つ可視作品の COUNT DISTINCT) で desc 順に並べて返す。
    NULL / 空文字 / is_visible=False の作品は集計から除外する。
    """
    items = await suggest_field_values(db, field=field, q=q, limit=limit)
    return SuggestResponse(items=items)
