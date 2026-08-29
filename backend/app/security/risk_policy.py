"""越权事件的 Redis 短窗口计数与分级策略。

本模块只产生策略判定，不修改用户账户状态。Phase 3/4 的账户状态服务负责消费
``suspended`` 判定并执行冻结；这样计数层不会绕过统一账户状态入口。
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Any

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


def _key(scope: str, value: Any) -> str:
    return f"security:ownership-denied:{scope}:{security_fingerprint(value)}"


async def _increment(key: str) -> int:
    """递增并只在首次写入时设置 TTL，避免重复请求延长窗口。"""
    redis = get_redis()
    pipe = redis.pipeline(transaction=True)
    pipe.incr(key)
    pipe.expire(key, WINDOW_SECONDS, nx=True)
    result = await pipe.execute()
    return int(result[0])


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

    peak = max(user_count, client_count or 0, ip_count or 0)
    action = "suspended" if peak >= SUSPEND_THRESHOLD else "throttled" if peak >= THROTTLE_THRESHOLD else "logged"
    return RiskDecision(
        user_count=user_count,
        client_count=client_count,
        ip_count=ip_count,
        action=action,
        applied=AUTO_RESPONSE_ENABLED and action != "logged",
    )
