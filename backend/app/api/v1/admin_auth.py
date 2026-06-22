"""
管理员认证接口
POST /api/v1/admin/auth/login   → 用户名+密码换 Token
GET  /api/v1/admin/auth/me      → 验证当前 Token
"""

from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import bcrypt as _bcrypt
from jose import jwt, JWTError
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import get_settings
from app.db.session import get_db

router = APIRouter(prefix="/admin/auth", tags=["admin-auth"])
bearer = HTTPBearer()


def _hash_pw(plain: str) -> str:
    return _bcrypt.hashpw(plain.encode(), _bcrypt.gensalt()).decode()


def _verify_pw(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode(), hashed.encode())


# ── 临时内置管理员（正式上线前改为从数据库读取）──
ADMIN_USERS = {
    "admin": {
        "username": "admin",
        # 默认密码 admin123，上线前必须修改
        "hashed_password": _hash_pw("admin123"),
        "role": "superadmin",
    }
}


class LoginRequest(BaseModel):
    username: str
    password: str


def _create_token(data: dict) -> str:
    cfg = get_settings()
    payload = {
        **data,
        "exp": datetime.utcnow() + timedelta(minutes=cfg.access_token_expire_minutes),
        "iat": datetime.utcnow(),
    }
    return jwt.encode(payload, cfg.secret_key, algorithm="HS256")


def _verify_token(credentials: HTTPAuthorizationCredentials = Depends(bearer)):
    cfg = get_settings()
    try:
        payload = jwt.decode(credentials.credentials, cfg.secret_key, algorithms=["HS256"])
        if payload.get("role") not in ("superadmin", "admin"):
            raise HTTPException(status_code=403, detail="权限不足")
        return payload
    except JWTError:
        raise HTTPException(status_code=401, detail="Token 无效或已过期")


@router.post("/login")
async def login(body: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    from app.api.v1.audit_log import write_log
    user = ADMIN_USERS.get(body.username)
    if not user or not _verify_pw(body.password, user["hashed_password"]):
        try:
            await write_log(db, body.username, "login", "登录失败：用户名或密码错误", request)
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    token = _create_token({"sub": user["username"], "role": user["role"]})
    try:
        await write_log(db, user["username"], "login", "登录成功", request)
    except Exception:
        pass
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {"username": user["username"], "role": user["role"]},
    }


@router.get("/me")
async def me(payload=Depends(_verify_token)):
    return {"username": payload["sub"], "role": payload["role"]}
