"""Provider reasoning state 的归属、加密、TTL 和乐观并发服务。"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent.context.reasoning_state import (
    INVALIDATION_REASONS,
    ProviderStateEnvelope,
    ReasoningPersistencePolicy,
)
from app.core.tz import now_utc
from app.core.ownership import get_owned
from app.byok.crypto import decrypt_envelope, encrypt_envelope
from app.models import ConversationSession, ProviderReasoningState


class ProviderStateConflict(RuntimeError):
    """提交时发现状态版本已被另一个 Run 更新。"""


class ProviderStateAccessError(LookupError):
    """会话不存在或不属于当前用户。"""


@dataclass(frozen=True, slots=True)
class ProviderStateLookup:
    envelope: ProviderStateEnvelope | None = field(default=None, repr=False)
    expected_version: int = 0
    unavailable_reason: str | None = None


def _invalidation_reason(row: ProviderReasoningState, *, provider: str, api_format: str,
                         model_id: str, config_digest: str,
                         reasoning_config_digest: str,
                         policy: ReasoningPersistencePolicy) -> str | None:
    if row.provider != provider:
        return "provider_changed"
    if row.api_format != api_format:
        return "api_format_changed"
    if row.model_id != model_id:
        return "model_changed"
    if row.config_digest != config_digest:
        return "config_changed"
    if row.reasoning_config_digest != reasoning_config_digest:
        return "reasoning_config_changed"
    if row.reasoning_persistence != policy.mode:
        return "mode_changed"
    return None


def _invalidate_row(row: ProviderReasoningState, reason: str, now: datetime) -> None:
    if reason not in INVALIDATION_REASONS:
        raise ValueError("无效的 provider state 失效原因")
    row.status = "invalidated"
    row.invalidated_reason = reason
    row.invalidated_at = now
    row.encrypted_payload = ""
    row.payload_nonce = ""
    row.encrypted_data_key = ""
    row.payload_size = 0
    row.version += 1
    row.updated_at = now


async def _owned_session(db: AsyncSession, user_id: Any, session_id: int) -> ConversationSession:
    session = await get_owned(db, ConversationSession, session_id, user_id)
    if session is None:
        raise ProviderStateAccessError("会话不存在")
    return session


async def _find_row(db: AsyncSession, user_id: Any, session_id: int, *, lock: bool = False):
    query = select(ProviderReasoningState).where(
        ProviderReasoningState.user_id == user_id,
        ProviderReasoningState.session_id == session_id,
    )
    if lock:
        query = query.with_for_update()
    return (await db.execute(query)).scalar_one_or_none()


async def load_state(
    db: AsyncSession,
    *,
    user_id: Any,
    session_id: int,
    policy: ReasoningPersistencePolicy,
    provider: str,
    api_format: str,
    model_id: str,
    config_digest: str,
    reasoning_config_digest: str,
    now: datetime | None = None,
) -> ProviderStateLookup:
    """读取匹配状态；所有不匹配、过期和解密失败都先失效再返回不可用。"""
    await _owned_session(db, user_id, session_id)
    row = await _find_row(db, user_id, session_id, lock=True)
    if row is None:
        reason = "disabled" if policy.mode == "off" else "summary_only" if policy.mode == "summary" else None
        return ProviderStateLookup(expected_version=0, unavailable_reason=reason)

    current = now or now_utc()
    if policy.mode == "off":
        if row.status == "active":
            _invalidate_row(row, "disabled", current)
        return ProviderStateLookup(expected_version=row.version, unavailable_reason="disabled")
    if policy.mode == "summary":
        if row.status == "active":
            _invalidate_row(row, "summary_only", current)
        return ProviderStateLookup(expected_version=row.version, unavailable_reason="summary_only")
    if row.status != "active":
        return ProviderStateLookup(
            expected_version=row.version,
            unavailable_reason=row.invalidated_reason or "state_invalidated",
        )
    if row.expires_at <= current:
        _invalidate_row(row, "expired", current)
        return ProviderStateLookup(expected_version=row.version, unavailable_reason="expired")

    mismatch = _invalidation_reason(
        row,
        provider=provider,
        api_format=api_format,
        model_id=model_id,
        config_digest=config_digest,
        reasoning_config_digest=reasoning_config_digest,
        policy=policy,
    )
    if mismatch:
        _invalidate_row(row, mismatch, current)
        return ProviderStateLookup(expected_version=row.version, unavailable_reason=mismatch)

    try:
        payload_json = decrypt_envelope(
            row.encrypted_payload,
            row.payload_nonce,
            row.encrypted_data_key,
            key_version=row.key_version,
        )
        payload = json.loads(payload_json)
        row.last_used_at = current
        row.updated_at = current
        envelope = ProviderStateEnvelope.from_payload(
            owner_user_id=user_id,
            session_id=row.session_id,
            provider=row.provider,
            api_format=row.api_format,
            model_id=row.model_id,
            reasoning_persistence=row.reasoning_persistence,
            config_digest=row.config_digest,
            reasoning_config_digest=row.reasoning_config_digest,
            source_run_id=row.source_run_id,
            source_round_id=row.source_round_id,
            sequence=row.sequence,
            state_kind=row.state_kind,
            payload=payload,
            expires_at=row.expires_at,
            created_at=row.created_at,
            last_used_at=current,
            state_summary=row.state_summary or {},
            version=row.state_version,
        )
    except Exception:
        _invalidate_row(row, "state_corrupt", current)
        return ProviderStateLookup(expected_version=row.version, unavailable_reason="state_corrupt")

    if envelope.payload_digest != row.payload_digest or envelope.payload_size != row.payload_size:
        _invalidate_row(row, "state_corrupt", current)
        return ProviderStateLookup(expected_version=row.version, unavailable_reason="state_corrupt")
    return ProviderStateLookup(envelope=envelope, expected_version=row.version)


async def commit_state(
    db: AsyncSession,
    *,
    user_id: Any,
    session_id: int,
    envelope: ProviderStateEnvelope,
    expected_version: int,
) -> int:
    """按 session 当前版本提交状态；返回新版本，冲突时不覆盖新状态。"""
    await _owned_session(db, user_id, session_id)
    if envelope.owner_user_id != str(user_id) or envelope.session_id != session_id:
        raise ProviderStateConflict("provider state 归属不匹配")
    if envelope.reasoning_persistence == "off":
        raise ValueError("off 策略不能提交 provider state")
    if envelope.reasoning_persistence == "summary":
        if envelope.state_kind != "summary" or not isinstance(envelope.payload, dict):
            raise ValueError("summary 策略不能提交完整 provider payload")
        if envelope.payload != envelope.state_summary:
            raise ValueError("summary 策略只能提交受限状态摘要")

    row = await _find_row(db, user_id, session_id, lock=True)
    if row is None:
        if expected_version != 0:
            raise ProviderStateConflict("provider state 版本已变化")
        encrypted, nonce, wrapped_key = encrypt_envelope(envelope.payload_json())
        row = ProviderReasoningState(
            user_id=user_id,
            session_id=session_id,
            version=1,
            state_version=envelope.version,
            status="active",
            provider=envelope.provider,
            api_format=envelope.api_format,
            model_id=envelope.model_id,
            reasoning_persistence=envelope.reasoning_persistence,
            config_digest=envelope.config_digest,
            reasoning_config_digest=envelope.reasoning_config_digest,
            source_run_id=envelope.source_run_id,
            source_round_id=envelope.source_round_id,
            sequence=envelope.sequence,
            state_kind=envelope.state_kind,
            encrypted_payload=encrypted,
            payload_nonce=nonce,
            encrypted_data_key=wrapped_key,
            key_version=1,
            payload_digest=envelope.payload_digest,
            payload_size=envelope.payload_size,
            state_summary=envelope.state_summary,
            created_at=envelope.created_at,
            last_used_at=envelope.last_used_at,
            expires_at=envelope.expires_at,
        )
        db.add(row)
        await db.flush()
        return row.version

    if row.version != expected_version:
        raise ProviderStateConflict("provider state 版本已变化")
    encrypted, nonce, wrapped_key = encrypt_envelope(envelope.payload_json())
    row.version += 1
    row.state_version = envelope.version
    row.status = "active"
    row.invalidated_reason = None
    row.invalidated_at = None
    row.provider = envelope.provider
    row.api_format = envelope.api_format
    row.model_id = envelope.model_id
    row.reasoning_persistence = envelope.reasoning_persistence
    row.config_digest = envelope.config_digest
    row.reasoning_config_digest = envelope.reasoning_config_digest
    row.source_run_id = envelope.source_run_id
    row.source_round_id = envelope.source_round_id
    row.sequence = envelope.sequence
    row.state_kind = envelope.state_kind
    row.encrypted_payload = encrypted
    row.payload_nonce = nonce
    row.encrypted_data_key = wrapped_key
    row.key_version = 1
    row.payload_digest = envelope.payload_digest
    row.payload_size = envelope.payload_size
    row.state_summary = envelope.state_summary
    row.created_at = envelope.created_at
    row.last_used_at = envelope.last_used_at
    row.expires_at = envelope.expires_at
    row.updated_at = now_utc()
    await db.flush()
    return row.version


async def invalidate_state(
    db: AsyncSession,
    *,
    user_id: Any,
    session_id: int,
    reason: str,
    expected_version: int | None = None,
) -> bool:
    await _owned_session(db, user_id, session_id)
    row = await _find_row(db, user_id, session_id, lock=True)
    if row is None:
        return False
    if expected_version is not None and row.version != expected_version:
        raise ProviderStateConflict("provider state 版本已变化")
    if row.status == "active":
        _invalidate_row(row, reason, now_utc())
        await db.flush()
    return True


async def delete_state(db: AsyncSession, *, user_id: Any, session_id: int) -> bool:
    """显式删除状态；会话/用户硬删除也由外键和 ORM cascade 覆盖。"""
    await _owned_session(db, user_id, session_id)
    row = await _find_row(db, user_id, session_id)
    if row is None:
        return False
    await db.delete(row)
    await db.flush()
    return True


async def expire_states(db: AsyncSession, *, now: datetime | None = None, limit: int | None = None) -> int:
    current = now or now_utc()
    query = select(ProviderReasoningState).where(
        ProviderReasoningState.status == "active",
        ProviderReasoningState.expires_at <= current,
    ).order_by(ProviderReasoningState.id)
    if limit is not None:
        query = query.limit(limit)
    rows = (await db.execute(query)).scalars().all()
    for row in rows:
        _invalidate_row(row, "expired", current)
    if rows:
        await db.flush()
    return len(rows)
