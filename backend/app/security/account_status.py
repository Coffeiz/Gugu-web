"""统一账户风险状态变更服务。"""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from app.core.tz import now_utc


async def suspend_user(db, user, *, duration_seconds: int, reason: str) -> None:
    """临时冻结用户并递增安全版本，使后续鉴权可识别状态变化。"""
    user.account_status = "suspended"
    user.suspended_until = now_utc() + timedelta(seconds=duration_seconds)
    user.suspended_reason = reason[:200]
    user.security_version = (user.security_version or 0) + 1
    user.is_active = False
    await db.commit()

async def unsuspend_user(db, user) -> None:
    """解封用户；不恢复已经断开的连接。"""
    user.account_status = "active"
    user.suspended_until = None
    user.suspended_reason = None
    user.security_version = (user.security_version or 0) + 1
    user.is_active = True
    await db.commit()
