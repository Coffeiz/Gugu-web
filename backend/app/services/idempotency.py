"""持久化创建请求幂等键；不根据名称、时间等业务字段猜测重复。"""
from __future__ import annotations

import hashlib
import json

from sqlalchemy import select


class IdempotencyConflict(ValueError):
    """同一幂等键被用于不同的创建内容。"""


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def idempotency_values(key: str | None, payload) -> tuple[str, str] | None:
    if key is None:
        return None
    raw_key = str(key).strip()
    if not raw_key or len(raw_key) > 256:
        raise ValueError("Idempotency-Key 必须为 1 至 256 个字符")
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return _digest(raw_key), _digest(canonical)


async def find_idempotent(db, model, user_id, key: str | None, payload):
    """返回相同键对应的既有资源；同键不同内容明确冲突。"""
    values = idempotency_values(key, payload)
    if values is None:
        return None
    key_hash, fingerprint = values
    row = (await db.execute(select(model).where(
        model.user_id == user_id,
        model.idempotency_key == key_hash,
    ))).scalar_one_or_none()
    if row is None:
        return None
    if row.idempotency_fingerprint != fingerprint:
        raise IdempotencyConflict("该 Idempotency-Key 已用于不同的创建内容")
    return row


def attach_idempotency(row, key: str | None, payload) -> None:
    values = idempotency_values(key, payload)
    if values is not None:
        row.idempotency_key, row.idempotency_fingerprint = values


def agent_create_key(operation: str, *, session_id: int | None, tool_call_id: str | None) -> str | None:
    """同一 Agent tool-call 重放沿用相同键；无真实 tool-call id 时不猜测。"""
    if session_id is None or not tool_call_id:
        return None
    return f"agent:{session_id}:{operation}:{tool_call_id}"
