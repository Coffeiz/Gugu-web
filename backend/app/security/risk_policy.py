"""越权事件的 Redis 短窗口计数与分级策略。

本模块负责短窗口判定和灰度下的统一策略执行；账户字段仍只由账户状态服务修改。
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from app.core.config import get_settings
from app.core.redis import get_redis
from app.security.events import security_fingerprint

WINDOW_SECONDS = 5 * 60
THROTTLE_THRESHOLD = 5
SUSPEND_THRESHOLD = 10
AUTO_RESPONSE_ENABLED = False
_DISABLED = "pytest" in sys.modules


@dataclass(frozen=True)
class RiskDecision:
    """一次短窗口计数后的策略结果。"""

    user_count: int
    client_count: int | None
    ip_count: int | None
    action: str
    applied: bool = False
    suspend_duration_seconds: int | None = None


def _key(scope: str, value: Any) -> str:
    return f"security:ownership-denied:{scope}:{security_fingerprint(value)}"


async def _increment(key: str) -> int:
    """递增并只在首次写入时设置 TTL，避免重复请求延长窗口。"""
    redis = get_redis()
    pipe = redis.pipeline(transaction=True)
    pipe.incr(key)
    pipe.expire(key, _policy().window_seconds, nx=True)
    result = await pipe.execute()
    return int(result[0])


@dataclass(frozen=True)
class _PolicyConfig:
    window_seconds: int
    throttle_threshold: int
    suspend_threshold: int
    suspend_duration_seconds: int
    auto_response_enabled: bool


def _policy() -> _PolicyConfig:
    """每次读取配置，支持 override.json 的 mtime 热更新。"""
    security = getattr(get_settings(), "security", None)
    if security is None:
        return _PolicyConfig(
            WINDOW_SECONDS, THROTTLE_THRESHOLD, SUSPEND_THRESHOLD, 10 * 60, AUTO_RESPONSE_ENABLED,
        )
    return _PolicyConfig(
        int(getattr(security, "ownership_window_seconds", WINDOW_SECONDS)),
        int(getattr(security, "ownership_throttle_threshold", THROTTLE_THRESHOLD)),
        int(getattr(security, "ownership_suspend_threshold", SUSPEND_THRESHOLD)),
        int(getattr(security, "ownership_suspend_duration_seconds", 10 * 60)),
        bool(getattr(security, "ownership_auto_response_enabled", AUTO_RESPONSE_ENABLED)),
    )


async def register_ownership_denial(
    *, user_id: Any, client_id: Any = None, ip_address: Any = None,
    force: bool = False,
) -> RiskDecision | None:
    """记录一次拒绝并返回分级策略判定；Redis 故障时 fail-open。"""
    if _DISABLED and not force:
        return None
    try:
        user_count = await _increment(_key("user", user_id))
        client_count = await _increment(_key("client", client_id)) if client_id is not None else None
        ip_count = await _increment(_key("ip", ip_address)) if ip_address is not None else None
    except Exception:
        return None

    config = _policy()
    peak = max(user_count, client_count or 0, ip_count or 0)
    action = "suspended" if peak >= config.suspend_threshold else "throttled" if peak >= config.throttle_threshold else "logged"
    return RiskDecision(
        user_count=user_count,
        client_count=client_count,
        ip_count=ip_count,
        action=action,
        applied=config.auto_response_enabled and action != "logged",
        suspend_duration_seconds=(
            config.suspend_duration_seconds if action == "suspended" else None
        ),
    )


async def is_user_throttled(user_id: Any, *, force: bool = False) -> bool:
    """检查用户是否仍处于越权限流窗口；Redis 故障时允许请求继续。"""
    if _DISABLED and not force:
        return False
    try:
        value = await get_redis().get(_key("user", user_id))
        return int(value or 0) >= _policy().throttle_threshold
    except Exception:
        return False


async def enforce_user_throttle(user_id: Any, *, force: bool = False) -> None:
    """在已鉴权的用户接口统一执行越权限流。"""
    if await is_user_throttled(user_id, force=force):
        raise HTTPException(
            status_code=429,
            detail="操作过于频繁，请稍后再试",
            headers={"Retry-After": str(_policy().window_seconds)},
        )


async def apply_risk_decision(user_id: Any, decision: RiskDecision | None) -> bool:
    """按灰度开关执行冻结；限流由 Redis 窗口和鉴权入口直接执行。"""
    config = _policy()
    if not decision or not config.auto_response_enabled or decision.action != "suspended":
        return False
    duration = decision.suspend_duration_seconds or config.suspend_duration_seconds
    try:
        from app.db import session as db_session
        from app.models import User
        from app.security.account_status import suspend_user

        db_session.ensure_engine()
        if db_session._SessionLocal is None:
            return False
        async with db_session._SessionLocal() as db:
            user = await db.get(User, user_id)
            if user is None:
                return False
            if getattr(user, "account_status", "active") == "suspended":
                return True
            await suspend_user(
                db, user, duration_seconds=duration,
                reason="risk_policy_auto_suspend",
            )
        return True
    except Exception:
        # 自动响应失败不能把原有越权拒绝变成放行。
        return False
