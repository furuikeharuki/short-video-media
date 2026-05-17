from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.schemas.actress import ActressDetail
from app.services.actress_service import get_actress_detail_service

router = APIRouter()


@router.get("/actresses/{name}", response_model=ActressDetail)
async def read_actress(
    name: str,
    movie_limit: int = Query(60, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> ActressDetail:
    """女優詳細を返す。
    name はパスパラメータの女優名 (URL デコード済み) を完全一致で検索する。
    DMM 女優検索 API 由来のプロフィール、出演作品、集計値を含む。
    """
    detail = await get_actress_detail_service(db, name=name, movie_limit=movie_limit)
    if detail is None:
        raise HTTPException(status_code=404, detail="Actress not found")
    return detail
