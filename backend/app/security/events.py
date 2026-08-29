"""安全事件事实记录与脱敏工具。

本模块只负责记录事实，不负责计数、限流或冻结。后续策略层以这里写入的事件为事实源。
"""
from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete

from app.core.config import get_settings
from app.core.tz import now_utc

SECURITY_EVENT_RETENTION_DAYS = 90
_ALLOWED_METADATA_KEYS = frozenset({"client_type", "endpoint", "source"})


def security_fingerprint(value: Any) -> str | None:
    """使用服务端密钥生成稳定指纹；空值不写入事件。"""
    if value is None:
        return None
    raw = str(value).encode("utf-8")
    key = get_settings().secret_key.encode("utf-8")
    return hmac.new(key, raw, hashlib.sha256).hexdigest()


def sanitize_metadata(metadata: dict[str, Any] | None) -> dict[str, str]:
    """只保留固定键和值类型，避免把请求对象或用户正文写入安全事件。"""
    if not metadata:
        return {}
    return {
        key: str(value)[:100]
        for key, value in metadata.items()
        if key in _ALLOWED_METADATA_KEYS and value is not None
    }


def build_ownership_event(*, requester_id: Any, model: Any, resource_id: Any, owner_id: Any) -> dict[str, Any]:
    """构造可持久化的脱敏事件字段，供测试和写入服务共用。"""
    return {
        "user_id": requester_id,
        "event_type": "ownership.denied",
        "resource_type": model.__name__,
        "resource_fingerprint": security_fingerprint(resource_id),
        "owner_fingerprint": security_fingerprint(owner_id),
        "action": "logged",
        "reason_code": "ownership_mismatch",
        "metadata_json": {},
        "occurred_at": now_utc(),
        "expires_at": now_utc() + timedelta(days=SECURITY_EVENT_RETENTION_DAYS),
    }


async def record_ownership_denied(*, requester_id: Any, model: Any, resource_id: Any, owner_id: Any) -> None:
    """在独立事务中记录越权拒绝，失败不得影响原请求的统一 None 语义。"""
    from app.db import session as db_session
    from app.models import SecurityEvent

    event = SecurityEvent(**build_ownership_event(
        requester_id=requester_id,
        model=model,
        resource_id=resource_id,
        owner_id=owner_id,
    ))
    db_session.ensure_engine()
    if db_session._SessionLocal is None:
        return
    async with db_session._SessionLocal() as event_db:
        event_db.add(event)
        await event_db.commit()


async def cleanup_expired_security_events(db, *, now: datetime | None = None) -> int:
    """删除到期安全事件，保留用户业务数据和未到期事件。"""
    from app.models import SecurityEvent

    cutoff = now or now_utc()
    result = await db.execute(
        delete(SecurityEvent).where(SecurityEvent.expires_at <= cutoff)
    )
    await db.commit()
    return max(result.rowcount or 0, 0)
