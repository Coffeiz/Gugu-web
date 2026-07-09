"""轻量限流：Redis 固定窗口计数。仅用于认证类端点防爆破/滥用（登录/注册/找回密码/admin 登录）。

设计取舍：
- **fail-open**：Redis 不可用时不拦——限流是加固层，不该因它挂掉而锁死登录。
- 固定窗口足够挡自动化爆破；精确性不是目标（不做滑动窗口/令牌桶那套）。
- 键按 IP（+可选 extra，如用户名）分桶，`incr` 首次置 `expire`。
"""
from __future__ import annotations

from fastapi import HTTPException, Request

from app.core.redis import get_redis


def _client_ip(request: Request) -> str:
    xff = request.headers.get("X-Forwarded-For")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def rate_limit(request: Request, bucket: str, limit: int, window: int, extra: str = "") -> None:
    """按 IP(+extra) 在 window 秒内最多 limit 次，超出抛 429。Redis 异常时 fail-open（放行）。"""
    try:
        ip = _client_ip(request)
        key = f"rl:{bucket}:{ip}" + (f":{extra}" if extra else "")
        r = get_redis()
        n = await r.incr(key)
        if n == 1:
            await r.expire(key, window)
        if n > limit:
            raise HTTPException(status_code=429, detail="操作过于频繁，请稍后再试")
    except HTTPException:
        raise
    except Exception:
        return  # Redis 挂了不拦——限流是加固不是主控
