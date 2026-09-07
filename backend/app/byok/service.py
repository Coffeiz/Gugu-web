"""BYOK 凭据查询、元数据输出和用户级加解密。"""
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.byok.crypto import decrypt_envelope, encrypt_envelope
from app.models import UserProviderCredential
from app.byok.policy import byok_enabled

_master_key_status = "unknown"


def byok_master_key_status() -> str:
    return _master_key_status


async def validate_master_key(db: AsyncSession) -> str:
    """启动期验证主密钥；失败只标记状态，不删除或改写凭据。"""
    global _master_key_status
    try:
        from app.byok.crypto import _master_key
        _master_key()
        row = (await db.execute(select(UserProviderCredential).where(
            UserProviderCredential.encrypted_value.is_not(None)
        ).order_by(UserProviderCredential.id).limit(1))).scalars().first()
        if row is not None:
            decrypt_value(row)
        _master_key_status = "ready"
    except Exception:
        _master_key_status = "needs_reconfigure"
    return _master_key_status


def master_key_status_for_credentials(rows: list[UserProviderCredential]) -> str:
    """校验当前用户的凭据；没有加密凭据时不返回需要重配状态。"""
    secured_rows = [row for row in rows if row.encrypted_value is not None]
    if not secured_rows:
        return "ready"
    try:
        from app.byok.crypto import _master_key
        _master_key()
        for row in secured_rows:
            decrypt_value(row)
    except Exception:
        return "needs_reconfigure"
    return "ready"


def credential_view(row: UserProviderCredential) -> dict:
    return {"id": row.id, "provider": row.provider, "api_format": row.api_format,
            "capability": row.capability,
            "base_url": row.base_url, "model": row.model,
            "max_tokens": getattr(row, "max_tokens", None), "vision": row.vision,
            "context_tokens": getattr(row, "context_tokens", None),
            "thinking": getattr(row, "thinking", None),
            "reasoning_effort": getattr(row, "reasoning_effort", None),
            "reasoning_persistence": getattr(row, "reasoning_persistence", "off"),
            "vision_video": row.vision_video, "vision_audio": row.vision_audio,
            "vision_detail": row.vision_detail, "enabled": row.enabled,
            "has_value": bool(row.encrypted_value), "last_verified_at": row.last_verified_at,
            "created_at": row.created_at, "updated_at": row.updated_at}


async def list_credentials(db: AsyncSession, user_id: UUID) -> list[UserProviderCredential]:
    result = await db.execute(select(UserProviderCredential).where(
        UserProviderCredential.user_id == user_id).order_by(UserProviderCredential.id))
    return list(result.scalars().all())


async def get_active_credential(db: AsyncSession, user_id: UUID, capability: str) -> UserProviderCredential | None:
    """按能力读取当前用户唯一启用凭据。"""
    if not byok_enabled():
        return None
    result = await db.execute(select(UserProviderCredential).where(
        UserProviderCredential.user_id == user_id,
        UserProviderCredential.capability == capability,
        UserProviderCredential.enabled.is_(True),
    ).order_by(UserProviderCredential.id))
    return next(iter(result.scalars().all()), None)


async def resolve_capability_settings(db: AsyncSession, user_id: UUID, capability: str, base):
    """返回带用户凭据覆盖的配置副本；没有用户凭据时保留平台配置。"""
    row = await get_active_credential(db, user_id, capability)
    if row is None:
        return base
    updates = {"api_key": decrypt_value(row), "provider": row.provider,
               "api_format": row.api_format, "base_url": row.base_url or getattr(base, "base_url", ""),
               "model": row.model or getattr(base, "model", ""), "vision": row.vision,
               "vision_video": row.vision_video, "vision_audio": row.vision_audio,
               "vision_detail": row.vision_detail}
    if capability == "llm":
        if getattr(row, "max_tokens", None) is not None:
            updates["max_tokens"] = row.max_tokens
        if getattr(row, "context_tokens", None) is not None:
            updates["context_tokens"] = row.context_tokens
        if getattr(row, "thinking", None) is not None:
            updates["thinking"] = row.thinking
        if getattr(row, "reasoning_effort", None) is not None:
            updates["reasoning_effort"] = row.reasoning_effort
        updates["reasoning_persistence"] = getattr(row, "reasoning_persistence", "off")
    return base.model_copy(update=updates) if hasattr(base, "model_copy") else base


def encrypt_value(value: str, key_version: int | None = None) -> tuple[str, str, str]:
    return encrypt_envelope(value, key_version=key_version)


def decrypt_value(row: UserProviderCredential) -> str:
    return decrypt_envelope(row.encrypted_value, row.nonce, row.encrypted_data_key,
                            key_version=row.key_version)
