"""BYOK 凭据查询、元数据输出和用户级加解密。"""
import logging
from contextlib import contextmanager
from contextvars import ContextVar
from types import SimpleNamespace
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.byok.crypto import decrypt_envelope, encrypt_envelope
from app.models import UserProviderCredential
from app.byok.policy import byok_enabled

_log = logging.getLogger(__name__)

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
            # dimensions 必须回给前端：漏掉会让编辑器拿到 null，保存时发 0 把已存维度清零。
            "dimensions": getattr(row, "dimensions", None),
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


async def get_owned_credential(db: AsyncSession, user_id: UUID, credential_id: int) -> UserProviderCredential | None:
    """按 id 取当前用户自己的凭据；不存在或归属他人一律返回 None（API 层转 404）。"""
    row = await db.get(UserProviderCredential, credential_id)
    if row is None or row.user_id != user_id:
        return None
    return row


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


async def has_active_credential(db: AsyncSession, capability: str, user_id: UUID | None = None) -> bool:
    """是否存在启用的指定能力凭据；user_id 缺省时不限用户（Admin 全局检查用）。"""
    stmt = select(UserProviderCredential.id).where(
        UserProviderCredential.capability == capability,
        UserProviderCredential.enabled.is_(True),
    )
    if user_id is not None:
        stmt = stmt.where(UserProviderCredential.user_id == user_id)
    return (await db.execute(stmt)).first() is not None


def _user_base_url(provider: str, base_url: str) -> str:
    """把用户凭据的 base_url 解析成真实请求目的地；**绝不读平台配置**。

    空串表示 provider 官方默认端点（与保存链路 _effective_origin 同一口径）：
    先走 provider adapter 的 default_base_url，再兜百炼系官方端点；都解析不出
    返回空串，由调用方按「目的地不明」拒绝覆盖——宁可回落平台配置，也不能把
    平台 base_url 拼上用户 Key 发出去。
    """
    url = (base_url or "").strip()
    if url:
        return url.rstrip("/")
    from agent.providers import adapter_for
    cfg = SimpleNamespace(provider=provider, base_url="")
    try:
        url = (adapter_for(cfg).resolve_base_url(cfg) or "").strip()
    except Exception:
        url = ""
    if url:
        return url.rstrip("/")
    try:
        from agent.memory.embedding import resolve_base_url as _embedding_base_url
        return (_embedding_base_url(provider, "") or "").rstrip("/")
    except Exception:
        return ""


async def resolve_capability_settings(db: AsyncSession, user_id: UUID, capability: str, base):
    """返回带用户凭据覆盖的配置副本；没有用户凭据时保留平台配置。

    base_url 是用户 Key 的目的地，只来自用户凭据本身：空串按 provider 默认端点
    解析，解析不出（目的地不明）→ 放弃覆盖回落平台配置，**绝不继承平台
    base_url**——否则用户 Key 会被拼到平台 endpoint 上发出去。
    """
    row = await get_active_credential(db, user_id, capability)
    if row is None:
        return base
    api_key = decrypt_value(row)  # 损坏信封在这里炸出来，不许静默回落平台配置
    base_url = _user_base_url(row.provider, row.base_url)
    if not base_url:
        return base
    updates = {"api_key": api_key, "provider": row.provider,
               "api_format": row.api_format, "base_url": base_url,
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


# ── Embedding BYOK ────────────────────────────────────────────────────────────
# embed() 是无用户上下文的共享基建（7 个调用点全在存储层，拿不到 db/session），
# 与 LLM BYOK 的 modelctx 同构：run 开始时解析一次并绑定到 ContextVar，
# agent.memory.embedding 的 embed/is_enabled/model_tag 优先读绑定值，无绑定回落平台。

_embedding_override: ContextVar[object | None] = ContextVar("byok_embedding_cfg", default=None)


async def resolve_embedding_settings(db: AsyncSession, user_id: UUID, base):
    """返回用户 embedding 生效配置；无凭据/解密失败/目的地或模型不全 → None。

    目的地绑定（运行时侧收口）：用户 Key 的目的地只来自用户凭据本身——
    base_url 与 model 都**绝不继承平台配置**（平台 URL 拼用户 Key 就是跨服务商
    泄漏；平台模型名发去用户端点也必然失败）。base_url 空串按 provider 官方
    默认端点解析（_user_base_url，与保存链路同口径），解析不出 → None，调用方
    沿用平台配置——BYOK 配置不完整只该降级到平台或词法检索，不能把记忆链路
    打炸。覆盖字段只有 embedding 相关五个；不使用 resolve_capability_settings
    （它会无条件注入 vision 等 LLM 专属字段）。
    """
    row = await get_active_credential(db, user_id, "embedding")
    if row is None:
        return None
    try:
        api_key = decrypt_value(row)
    except Exception:
        _log.warning("byok embedding 凭据解密失败，回落平台配置 user=%s", str(user_id)[:8])
        return None
    base_url = _user_base_url(row.provider, row.base_url)
    model = (row.model or "").strip()
    if not model or not base_url:
        return None
    return {"provider": row.provider, "api_key": api_key, "base_url": base_url,
            "model": model,
            # dimensions 用户值为 0/None 表示明确用其模型默认维度，不继承平台值。
            "dimensions": row.dimensions or 0}


def effective_embedding_override() -> dict | None:
    """当前上下文绑定的用户 embedding 配置；未绑定返回 None。"""
    return _embedding_override.get()


@contextmanager
def bind_user_embedding(cfg: dict | None):
    """在用户链路 run 开始时调用；cfg 为 resolve_embedding_settings 的结果（可为 None）。

    reset 必须配对执行，避免 ContextVar 泄漏到复用该任务的后续调用。
    """
    token = _embedding_override.set(cfg)
    try:
        yield
    finally:
        _embedding_override.reset(token)


async def resolve_and_bind_user_embedding(settings, db: AsyncSession, user_id: UUID) -> None:
    """解析用户 embedding 生效配置并绑定到当前任务上下文。

    与 modelctx.set_model_cfg 同一纪律：不 reset，上下文随请求/任务结束消亡，
    派生的后台任务（反思/压缩）经 create_task 继承同一绑定。解析或查询失败
    按 None（回落平台配置）处理，绝不影响 run 本身。
    """
    try:
        cfg = await resolve_embedding_settings(db, user_id, settings.embedding)
    except Exception:
        _log.warning("byok embedding 绑定失败，回落平台配置 user=%s", str(user_id)[:8])
        cfg = None
    _embedding_override.set(cfg)


def encrypt_value(value: str, key_version: int | None = None,
                  allow_empty: bool = False) -> tuple[str, str, str]:
    return encrypt_envelope(value, key_version=key_version, allow_empty=allow_empty)


def decrypt_value(row: UserProviderCredential) -> str:
    return decrypt_envelope(row.encrypted_value, row.nonce, row.encrypted_data_key,
                            key_version=row.key_version)
