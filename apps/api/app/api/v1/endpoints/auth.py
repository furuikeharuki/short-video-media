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
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.rate_limit import (
    SlidingWindowRateLimiter,
    get_signin_rate_limiter,
)
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


async def _get_or_create_identity(
    db: AsyncSession, provider: str, sub_hash: str
) -> str:
    """Identity (provider, sub_hash) から User を get_or_create し、user_id を返す。

    UNIQUE(provider, sub_hash) 制約があるため、同一ユーザーが同時に複数の
    sign-in を投げると INSERT が衝突する。IntegrityError を catch して
    再 SELECT することで安全に冪等化する。
    """
    # Step1: 既存 Identity を引く
    result = await db.execute(
        select(Identity).where(
            Identity.provider == provider, Identity.sub_hash == sub_hash
        )
    )
    identity = result.scalar_one_or_none()

    if identity is not None:
        # last_seen_at を更新
        result2 = await db.execute(
            select(User).where(User.id == identity.user_id)
        )
        user = result2.scalar_one()
        user.last_seen_at = _utcnow_naive()
        await db.commit()
        return user.id

    # Step2: 新規作成。UNIQUE 衝突に備えて savepoint で囲み、失敗時は再 SELECT。
    try:
        user = User()
        db.add(user)
        await db.flush()  # user.id を確定させる
        identity = Identity(
            user_id=user.id, provider=provider, sub_hash=sub_hash
        )
        db.add(identity)
        await db.commit()
        return user.id
    except IntegrityError:
        # 並行 sign-in で他リクエストが先に Identity を作ったケース。
        # ロールバックしてから再度 SELECT する。再 SELECT で見つからなければ
        # 一過的な別エラーなので、そのまま 500 系として上位に投げる。
        await db.rollback()
        result3 = await db.execute(
            select(Identity).where(
                Identity.provider == provider, Identity.sub_hash == sub_hash
            )
        )
        identity = result3.scalar_one_or_none()
        if identity is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="sign-in conflict, please retry",
            )
        result4 = await db.execute(
            select(User).where(User.id == identity.user_id)
        )
        user = result4.scalar_one()
        user.last_seen_at = _utcnow_naive()
        await db.commit()
        return user.id


@router.post("/sign-in", response_model=SignInResponse)
async def sign_in(
    body: SignInRequest,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    limiter: Annotated[
        SlidingWindowRateLimiter, Depends(get_signin_rate_limiter)
    ],
) -> SignInResponse:
    """provider+sub から User を get_or_create して User JWT を返す。"""
    # IP ごとのレート制限。盗まれた exchange JWT の総当たりや、大量ユーザー
    # 作成攻撃を抑制する。
    limiter.check(request)

    payload = _decode_exchange_token(body.exchange_token)
    provider: str = payload["provider"]
    sub: str = payload["sub"]
    sub_hash = compute_sub_hash(provider, sub)

    user_id = await _get_or_create_identity(db, provider, sub_hash)

    token = create_user_token(user_id)
    return SignInResponse(token=token, user_id=user_id)
