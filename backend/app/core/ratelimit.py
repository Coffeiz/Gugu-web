"""轻量限流：Redis 固定窗口计数。仅用于认证类端点防爆破/滥用（登录/注册/找回密码/admin 登录）。

设计取舍：
- 默认 **fail-open**，避免 Redis 故障锁死既有认证流程；注册等敏感端点可以指定 **fail-closed**。
- 固定窗口足够挡自动化爆破；精确性不是目标（不做滑动窗口/令牌桶那套）。
- 按 IP、可选设备 ID 和 extra 分桶；标识先摘要再写入 Redis。
"""
from __future__ import annotations

import hashlib
import ipaddress
import re

from fastapi import HTTPException, Request

from app.core.redis import get_redis


def _client_ip(request: Request) -> str:
    xff = request.headers.get("X-Forwarded-For")
    if xff:
        # 反向代理会把实际 TCP 对端追加到 XFF 右侧；不要信任客户端可自行
        # 填写的左侧值，否则可通过伪造 XFF 绕过按 IP 的频次限制。
        candidates = [part.strip() for part in xff.split(",") if part.strip()]
        if candidates:
            try:
                return str(ipaddress.ip_address(candidates[-1]))
            except ValueError:
                pass
    peer = request.client.host if request.client else "unknown"
    try:
        return str(ipaddress.ip_address(peer))
    except ValueError:
        return "unknown"


async def rate_limit(
    request: Request,
    bucket: str,
    limit: int,
    window: int,
    extra: str = "",
    *,
    device_limit: int | None = None,
    device_window: int | None = None,
    fail_closed: bool = False,
) -> None:
    """按 IP 及可选设备标识执行固定窗口限流。

    设备标识只接受格式受限的客户端随机 ID，并以摘要写入 Redis；没有设备 ID 时仍按 IP 限流。
    Redis 故障默认 fail-open，注册等安全边界可选择 fail-closed。
    """
    try:
        ip = _client_ip(request)
        r = get_redis()
        extra_part = f":{hashlib.sha256(extra.encode('utf-8')).hexdigest()[:24]}" if extra else ""

        async def check(key: str, maximum: int, ttl: int) -> None:
            count = await r.incr(key)
            if count == 1:
                await r.expire(key, ttl)
            if count > maximum:
                raise HTTPException(status_code=429, detail="操作过于频繁，请稍后再试")

        ip_hash = hashlib.sha256(ip.encode("utf-8")).hexdigest()
        await check(f"rl:{bucket}:ip:{ip_hash}{extra_part}", limit, window)

        raw_device_id = request.headers.get("X-Device-ID", "").strip()
        if device_limit is not None and re.fullmatch(r"[A-Za-z0-9_-]{16,128}", raw_device_id):
            device_hash = hashlib.sha256(raw_device_id.encode("utf-8")).hexdigest()
            await check(
                f"rl:{bucket}:device:{device_hash}{extra_part}",
                device_limit,
                device_window or window,
            )
    except HTTPException:
        raise
    except Exception:
        if fail_closed:
            raise HTTPException(status_code=503, detail="注册服务暂不可用，请稍后重试") from None
        return  # 其他既有认证限流仍按 fail-open 策略处理
