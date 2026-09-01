from datetime import datetime, timedelta
from app.core.tz import now_utc
from uuid import UUID
from dataclasses import dataclass

import bcrypt as _bcrypt
import secrets

from fastapi import Depends, Header, HTTPException, Request
from fastapi.responses import Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_db

_bearer = HTTPBearer(auto_error=False)

USER_ACCESS_COOKIE = "gugu_user_access_token"
USER_CSRF_COOKIE = "gugu_user_csrf_token"
ADMIN_ACCESS_COOKIE = "gugu_admin_access_token"
ADMIN_CSRF_COOKIE = "gugu_admin_csrf_token"
CSRF_HEADER = "X-CSRF-Token"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@dataclass(frozen=True)
class CurrentUserIdentity:
    """不绑定 request DB 生命周期的用户身份快照。"""

    id: UUID
    username: str


def _cookie_secure(request: Request) -> bool:
    """仅在 HTTPS 请求上设置 Secure，兼容当前 HTTP devserver。"""
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip() == "https"


def set_auth_cookies(
    response: Response,
    token: str,
    access_cookie: str,
    csrf_cookie: str,
    request: Request,
) -> None:
    csrf_token = secrets.token_urlsafe(32)
    max_age = get_settings().access_token_expire_minutes * 60
    secure = _cookie_secure(request)
    response.set_cookie(
        access_cookie,
        token,
        max_age=max_age,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        csrf_cookie,
        csrf_token,
        max_age=max_age,
        httponly=False,
        secure=secure,
        samesite="lax",
        path="/",
    )


def clear_auth_cookies(response: Response, access_cookie: str, csrf_cookie: str) -> None:
    response.delete_cookie(access_cookie, path="/")
    response.delete_cookie(csrf_cookie, path="/")


def request_auth_token(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None,
    *,
    access_cookie: str,
    csrf_cookie: str,
) -> str:
    """优先取 Bearer；浏览器无 Bearer 时取 Cookie 并校验写请求 CSRF。"""
    if credentials and credentials.credentials:
        return credentials.credentials

    token = request.cookies.get(access_cookie)
    if not token:
        raise HTTPException(status_code=401, detail="未提供认证凭据")
    if request.method.upper() not in _SAFE_METHODS:
        csrf_value = request.cookies.get(csrf_cookie)
        csrf_header = request.headers.get(CSRF_HEADER)
        if not csrf_value or not csrf_header or not secrets.compare_digest(csrf_value, csrf_header):
            raise HTTPException(status_code=403, detail="CSRF 校验失败")
    return token


def account_is_active(user) -> bool:
    """统一解释账户状态；旧数据缺少新字段时按 active 兼容。"""
    return bool(
        user
        and user.is_active
        and getattr(user, "account_status", "active") == "active"
    )


async def is_user_active(user_id: UUID) -> bool:
    """使用短生命周期独立会话检查账户，适用于 SSE/WS 轮询。"""
    from app.db import session as db_session
    from app.models import User

    db_session.ensure_engine()
    if db_session._SessionLocal is None:
        return False
    async with db_session._SessionLocal() as db:
        return account_is_active(await db.get(User, user_id))


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


def get_client_id(x_client_id: str | None = Header(default=None)) -> str | None:
    """发起请求的浏览器标签页 client-id（前端 api.ts 每次写操作带的 X-Client-Id 头）。
    透传给 events.publish 的 origin，用于回声抑制。缺省 None（如咕咕/IM 侧、老前端）。"""
    return x_client_id


async def get_current_user_id(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> UUID:
    """解析 JWT 并在建立长连接前检查账户状态，不持有请求级 DB session。"""
    settings = get_settings()
    try:
        token = request_auth_token(request, credentials, access_cookie=USER_ACCESS_COOKIE, csrf_cookie=USER_CSRF_COOKIE)
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        if payload.get("role") != "user":
            raise ValueError
        user_id = UUID(payload["sub"])
        if not await is_user_active(user_id):
            raise HTTPException(status_code=401, detail="用户不存在或已停用")
        from app.security.risk_policy import enforce_user_throttle
        await enforce_user_throttle(user_id)
        return user_id
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Token 无效或已过期")


async def get_current_user_identity(
    user_id: UUID = Depends(get_current_user_id),
) -> CurrentUserIdentity:
    """为 StreamingResponse/长连接提供短事务身份快照。"""
    from app.db import session as db_session
    from app.models import User

    db_session.ensure_engine()
    if db_session._SessionLocal is None:
        raise HTTPException(status_code=503, detail="数据库暂不可用")
    async with db_session._SessionLocal() as db:
        user = await db.get(User, user_id)
        if not account_is_active(user):
            raise HTTPException(status_code=401, detail="用户不存在或已停用")
        return CurrentUserIdentity(id=user.id, username=user.username)


def decode_user_token(token: str) -> UUID:
    """解析 WebSocket 等无法自定义 Authorization 头的长连接令牌。"""
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        if payload.get("role") != "user":
            raise ValueError
        return UUID(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Token 无效或已过期")


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
):
    from app.models import User

    settings = get_settings()
    try:
        token = request_auth_token(request, credentials, access_cookie=USER_ACCESS_COOKIE, csrf_cookie=USER_CSRF_COOKIE)
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        if payload.get("role") != "user":
            raise ValueError("not a user token")
        user_id = UUID(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Token 无效或已过期")

    user = await db.get(User, user_id)
    if not account_is_active(user):
        raise HTTPException(status_code=401, detail="用户不存在或已停用")
    from app.security.risk_policy import enforce_user_throttle
    await enforce_user_throttle(user_id)
    return user
