"""グッズ (FANZA mono/goods フロア) リポジトリ。"""
from __future__ import annotations

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.goods import Goods


async def get_popular_goods(
    db: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
) -> list[Goods]:
    """「人気商品」ランキング用の商品取得。

    現状 affiliate_click イベントはムービー詳細ページからしか発火していないため、
    商品単体での集計データが存在しない。review_count → review_average → primary_date
    の順で並べ、新しめかつレビュー実績のある商品を上位に出す。
    SQL OFFSET/LIMIT を使うのでページネーション計算量は limit 件だけ。
    """
    stmt = (
        select(Goods)
        .where(Goods.is_visible.is_(True))
        .order_by(
            desc(Goods.review_count),
            desc(Goods.review_average),
            desc(Goods.primary_date),
            Goods.id,
        )
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().unique().all())
