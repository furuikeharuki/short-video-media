"""認証エンドポイント。

このサービスは provider 側のユーザー情報を一切保存しない。
Next.js (auth.js v5) から渡された短期 "exchange JWT" を検証し、
内部 User を get_or_create したうえで、サービス用 User JWT を発行して返す。

exchange JWT (Next.js が発行) の payload 例:
    {
      "purpose": "signin",
      "provider": "twitter" | "discord",
      "sub": "<provider 側のユーザーID>",
      "aud": "short-video-media-signin",
      "iat": <unix>,
      "exp": <unix>  # 60秒くらい
    }

User JWT (FastAPI が返却) の payload:
    {
      "sub": "<内部 user_id (UUID)>",
      "aud": settings.JWT_AUDIENCE,
      "iat": <unix>,
      "exp": <unix>  # 30日
    }
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import (
    ALLOWED_PROVIDERS,
    JWT_ALGORITHM,
    compute_sub_hash,
    create_user_token,
)
from app.db.models.user import Identity, User
from app.db.session import get_db

router = APIRouter(prefix="/auth")

SIGNIN_AUDIENCE = "short-video-media-signin"


class SignInRequest(BaseModel):
    exchange_token: str = Field(..., description="Next.js 側で発行した短期 JWT")


class SignInResponse(BaseModel):
    token: str
    user_id: str


def _decode_exchange_token(token: str) -> dict:
    try:
        decoded = jwt.decode(
            token,
            settings.AUTH_SECRET,
            algorithms=[JWT_ALGORITHM],
            audience=SIGNIN_AUDIENCE,
        )
    except jwt.ExpiredSignatureError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Exchange token expired",
        ) from e
    except jwt.PyJWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid exchange token",
        ) from e
    if decoded.get("purpose") != "signin":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid exchange token purpose",
        )
    provider = decoded.get("provider")
    sub = decoded.get("sub")
    if provider not in ALLOWED_PROVIDERS or not isinstance(sub, str) or not sub:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid provider or sub",
        )
    return decoded


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@router.post("/sign-in", response_model=SignInResponse)
async def sign_in(
    body: SignInRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> SignInResponse:
    """provider+sub から User を get_or_create して User JWT を返す。"""
    payload = _decode_exchange_token(body.exchange_token)
    provider: str = payload["provider"]
    sub: str = payload["sub"]
    sub_hash = compute_sub_hash(provider, sub)

    # Identity を引いて User を取得
    result = await db.execute(
        select(Identity).where(
            Identity.provider == provider, Identity.sub_hash == sub_hash
        )
    )
    identity = result.scalar_one_or_none()

    if identity is None:
        # 新規ユーザー作成
        user = User()
        db.add(user)
        await db.flush()  # user.id を確定させる
        identity = Identity(
            user_id=user.id, provider=provider, sub_hash=sub_hash
        )
        db.add(identity)
        await db.commit()
        user_id = user.id
    else:
        # last_seen_at を更新
        result2 = await db.execute(select(User).where(User.id == identity.user_id))
        user = result2.scalar_one()
        user.last_seen_at = _utcnow_naive()
        await db.commit()
        user_id = user.id

    token = create_user_token(user_id)
    return SignInResponse(token=token, user_id=user_id)
