"""認証・JWT 関連のユーティリティ。

- compute_sub_hash: provider と provider 側ユーザーID (sub) をソルト付き SHA-256 でハッシュ化
- create_user_token: 内部 user_id を sub クレームに入れた JWT を発行
- decode_user_token: JWT を検証して payload を返す
- require_user: FastAPI 依存。Authorization: Bearer <jwt> を検証し User を返す
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Annotated, TypedDict

import jwt
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models.user import User
from app.db.session import get_db


JWT_ALGORITHM = "HS256"
ALLOWED_PROVIDERS = frozenset({"twitter", "discord"})


class TokenPayload(TypedDict):
    sub: str  # 内部 user_id (UUID 文字列)
    iat: int
    exp: int
    aud: str


def compute_sub_hash(provider: str, sub: str) -> str:
    """provider + provider 側 sub を SHA-256(salt 付き) でハッシュ化する。

    Note:
      生の sub は絶対に DB に保存しない。常にこの関数を通したハッシュ値だけを保存する。
    """
    raw = f"{provider}:{sub}:{settings.APP_USER_SALT}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def create_user_token(user_id: str) -> str:
    """内部 user_id を sub クレームに入れた JWT を発行する。"""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=settings.JWT_EXPIRES_SECONDS)).timestamp()),
        "aud": settings.JWT_AUDIENCE,
    }
    return jwt.encode(payload, settings.AUTH_SECRET, algorithm=JWT_ALGORITHM)


def decode_user_token(token: str) -> TokenPayload:
    """JWT を検証して payload を返す。失敗時は HTTPException(401) を投げる。"""
    try:
        decoded = jwt.decode(
            token,
            settings.AUTH_SECRET,
            algorithms=[JWT_ALGORITHM],
            audience=settings.JWT_AUDIENCE,
        )
    except jwt.ExpiredSignatureError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired"
        ) from e
    except jwt.PyJWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        ) from e
    if not isinstance(decoded.get("sub"), str):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload"
        )
    return decoded  # type: ignore[return-value]


def _extract_bearer(request: Request) -> str:
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Authorization required"
        )
    parts = auth.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authorization header"
        )
    return parts[1].strip()


async def require_user(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    """Authorization: Bearer <jwt> を検証し、User を返す。"""
    token = _extract_bearer(request)
    payload = decode_user_token(token)
    user_id = payload["sub"]
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found"
        )
    return user


async def get_optional_user(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User | None:
    """Authorization があれば User、なければ/無効なら None を返す。

    検索のように「ログインしていなくても使える」エンドポイントで、ログイン中なら
    サーバ側 NG ワードを自動適用する用途で使う。token が壊れているからといって
    401 を投げてしまうと「未ログイン扱いで使い続ける」が許されなくなるため、
    ここでは全ての失敗ケースを None に倒す。
    """
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth:
        return None
    parts = auth.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        return None
    token = parts[1].strip()
    try:
        decoded = jwt.decode(
            token,
            settings.AUTH_SECRET,
            algorithms=[JWT_ALGORITHM],
            audience=settings.JWT_AUDIENCE,
        )
    except jwt.PyJWTError:
        return None
    user_id = decoded.get("sub")
    if not isinstance(user_id, str):
        return None
    result = await db.execute(select(User).where(User.id == user_id))
    return result.scalar_one_or_none()
