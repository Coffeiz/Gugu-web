"""
管理员认证接口
POST /api/v1/admin/auth/login   → 用户名+密码换 Token
GET  /api/v1/admin/auth/me      → 验证当前 Token
"""

from datetime import datetime, timedelta
from app.core.tz import now_utc
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import bcrypt as _bcrypt
from jose import jwt, JWTError
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import get_settings
from app.db.session import get_db
from app.core.security import (
    ADMIN_ACCESS_COOKIE,
    ADMIN_CSRF_COOKIE,
    clear_auth_cookies,
    request_auth_token,
    set_auth_cookies,
)
from app.core.redis import get_redis

router = APIRouter(prefix="/admin/auth", tags=["admin-auth"])
bearer = HTTPBearer(auto_error=False)
ADMIN_AUTH_VERSION_KEY = "auth:admin:security-version"


async def _admin_auth_version() -> int:
    try:
        return int(await get_redis().get(ADMIN_AUTH_VERSION_KEY) or 0)
    except Exception:
        raise HTTPException(status_code=503, detail="管理员认证服务暂不可用") from None


async def ensure_admin_token_current(payload: dict) -> None:
    if int(payload.get("av", 0)) != await _admin_auth_version():
        raise HTTPException(status_code=401, detail="Token 无效或已撤销")


def _hash_pw(plain: str) -> str:
    return _bcrypt.hashpw(plain.encode(), _bcrypt.gensalt()).decode()


def _verify_pw(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode(), hashed.encode())


def _get_admin_users():
    cfg = get_settings()
    name = cfg.admin_username or "admin"
    return {
        name: {
            "username": name,
            "hashed_password": _hash_pw(cfg.admin_password),
            "role": "superadmin",
        }
    }


class LoginRequest(BaseModel):
    username: str
    password: str


async def _create_token(data: dict) -> str:
    cfg = get_settings()
    payload = {
        **data,
        "exp": now_utc() + timedelta(minutes=cfg.access_token_expire_minutes),
        "iat": now_utc(),
        "av": await _admin_auth_version(),
    }
    return jwt.encode(payload, cfg.secret_key, algorithm="HS256")


async def _verify_token(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    cfg = get_settings()
    try:
        token = request_auth_token(request, credentials, access_cookie=ADMIN_ACCESS_COOKIE, csrf_cookie=ADMIN_CSRF_COOKIE)
        payload = jwt.decode(token, cfg.secret_key, algorithms=["HS256"])
        if payload.get("role") not in ("superadmin", "admin"):
            raise HTTPException(status_code=403, detail="权限不足")
        await ensure_admin_token_current(payload)
        return payload
    except JWTError:
        raise HTTPException(status_code=401, detail="Token 无效或已过期")


@router.post("/login")
async def login(body: LoginRequest, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    from app.api.v1.audit_log import write_log
    from app.core.ratelimit import rate_limit
    await rate_limit(request, "adminlogin", 10, 300)   # 同 IP 5 分钟最多 10 次 admin 登录尝试
    if not get_settings().admin_password:
        raise HTTPException(status_code=503, detail="管理员密码未配置，请先设置 ADMIN_PASSWORD")
    user = _get_admin_users().get(body.username)
    if not user or not _verify_pw(body.password, user["hashed_password"]):
        try:
            await write_log(db, body.username, "login", "登录失败：用户名或密码错误", request)
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    token = await _create_token({"sub": user["username"], "role": user["role"]})
    set_auth_cookies(response, token, ADMIN_ACCESS_COOKIE, ADMIN_CSRF_COOKIE, request)
    try:
        await write_log(db, user["username"], "login", "登录成功", request)
    except Exception:
        pass
    result = {
        "user": {"username": user["username"], "role": user["role"]},
    }
    if request.headers.get("X-Auth-Transport") != "cookie":
        result.update({"access_token": token, "token_type": "bearer"})
    return result


@router.post("/logout")
async def logout(response: Response, request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    token = request_auth_token(request, credentials, access_cookie=ADMIN_ACCESS_COOKIE, csrf_cookie=ADMIN_CSRF_COOKIE)
    try:
        payload = jwt.decode(token, get_settings().secret_key, algorithms=["HS256"])
        if payload.get("role") not in ("superadmin", "admin"):
            raise ValueError
        await ensure_admin_token_current(payload)
        await get_redis().incr(ADMIN_AUTH_VERSION_KEY)
    except JWTError:
        raise HTTPException(status_code=401, detail="Token 无效或已过期") from None
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=503, detail="管理员认证服务暂不可用") from None
    clear_auth_cookies(response, ADMIN_ACCESS_COOKIE, ADMIN_CSRF_COOKIE)
    return {"ok": True}


@router.get("/me")
async def me(payload=Depends(_verify_token)):
    return {"username": payload["sub"], "role": payload["role"]}
