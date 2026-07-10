from datetime import datetime, timedelta
from app.core.tz import now_utc
from uuid import UUID

import bcrypt as _bcrypt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_db

_bearer = HTTPBearer()


def hash_password(plain: str) -> str:
    return _bcrypt.hashpw(plain.encode(), _bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode(), hashed.encode())


def create_stream_token(file_id: int, user_id: UUID, expires_minutes: int = 10) -> str:
    settings = get_settings()
    expire = now_utc() + timedelta(minutes=expires_minutes)
    return jwt.encode(
        {"sub": str(user_id), "fid": file_id, "role": "stream", "exp": expire},
        settings.secret_key,
        algorithm="HS256",
    )


def verify_stream_token(token: str) -> tuple[int, UUID]:
    """Returns (file_id, user_id). Raises HTTPException on invalid/expired token."""
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        if payload.get("role") != "stream":
            raise ValueError
        return int(payload["fid"]), UUID(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="stream token 无效或已过期")


def create_user_token(user_id: UUID) -> str:
    settings = get_settings()
    expire = now_utc() + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode(
        {"sub": str(user_id), "role": "user", "exp": expire},
        settings.secret_key,
        algorithm="HS256",
    )


async def get_current_user_id(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> UUID:
    """JWT-only auth，不查 DB——用于 SSE 等长连接，避免占住 pool。"""
    settings = get_settings()
    try:
        payload = jwt.decode(credentials.credentials, settings.secret_key, algorithms=["HS256"])
        if payload.get("role") != "user":
            raise ValueError
        return UUID(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Token 无效或已过期")


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
):
    from app.models import User

    settings = get_settings()
    try:
        payload = jwt.decode(credentials.credentials, settings.secret_key, algorithms=["HS256"])
        if payload.get("role") != "user":
            raise ValueError("not a user token")
        user_id = UUID(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Token 无效或已过期")

    user = await db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="用户不存在或已停用")
    return user
