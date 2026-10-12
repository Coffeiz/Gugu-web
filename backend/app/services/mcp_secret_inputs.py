"""IM MCP secret prompt 的短时状态与密文 staging。"""
from __future__ import annotations

import binascii
import json
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from cryptography.exceptions import InvalidTag
from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.byok.crypto import decrypt_envelope, encrypt_envelope
from app.core.tz import now_utc
from app.models import ConversationSession, InteractionPrompt, McpSecretInput, UserMcpServer
from app.services.secret_prompts import validate_secret_values

IM_SOURCES = {"qq", "feishu", "wechat", "telegram"}
ACTIVE_STATES = {"pending_choice", "awaiting_secret"}
MAX_EVENT_IDS = 32  # 最多 16 字段 + 启动/取消；保留整个短时交互的重放去重依据。


@dataclass(frozen=True)
class McpSecretBinding:
    """一次 IM 输入必须完全匹配的身份和交互作用域。"""

    prompt_id: int
    user_id: UUID
    platform: str
    bot_id: str
    chat_type: str
    chat_id: str | None
    platform_user_id: str


def _schema(prompt: InteractionPrompt) -> dict:
    return prompt.schema_json if isinstance(prompt.schema_json, dict) else {}


def _clear_payload(staging: McpSecretInput, status: str) -> None:
    staging.status = status
    staging.encrypted_payload = ""
    staging.payload_nonce = ""
    staging.encrypted_data_key = ""


async def create_im_secret_staging(
    db: AsyncSession,
    *,
    prompt: InteractionPrompt,
    session: ConversationSession,
    server_id: str,
) -> McpSecretInput | None:
    """仅为身份完整的一对一 IM 会话创建 staging；群聊/Web 不建立输入状态。"""
    if (
        session.source not in IM_SOURCES
        or session.chat_type != "c2c"
        or not session.bot_id
        or not session.platform_user_id
        or session.chat_id
    ):
        return None
    try:
        parsed_server_id = UUID(str(server_id))
    except (ValueError, TypeError, AttributeError):
        return None
    server = await db.scalar(select(UserMcpServer).where(
        UserMcpServer.id == parsed_server_id,
        UserMcpServer.user_id == prompt.user_id,
        UserMcpServer.scope == "user",
    ))
    if server is None:
        return None
    stage = McpSecretInput(
        prompt_id=prompt.id,
        user_id=prompt.user_id,
        server_id=server.id,
        session_id=session.id,
        platform=session.source,
        bot_id=session.bot_id,
        chat_id=session.chat_id,
        chat_type=session.chat_type,
        platform_user_id=session.platform_user_id,
        expires_at=prompt.expires_at,
    )
    db.add(stage)
    await db.flush()
    return stage


async def stage_prompt_if_private_mcp(
    db: AsyncSession,
    *,
    prompt: InteractionPrompt,
    context: dict,
) -> bool:
    target = context.get("secret_target") if isinstance(context, dict) else None
    if not isinstance(target, dict) or target.get("kind") != "mcp_credentials":
        return False
    session = await db.get(ConversationSession, prompt.session_id)
    if session is None:
        return False
    stage = await create_im_secret_staging(
        db, prompt=prompt, session=session,
        server_id=str(target.get("server_id") or ""),
    )
    return stage is not None


async def find_im_secret_prompt(db: AsyncSession, payload: dict) -> tuple[str, InteractionPrompt, McpSecretInput | None] | None:
    """按完整 IM 会话身份查找活动凭据交互；群聊只返回拒绝门，不创建输入态。"""
    try:
        user_id = UUID(str(payload.get("owner_user_id") or ""))
    except (TypeError, ValueError, AttributeError):
        return None
    platform = str(payload.get("platform") or "")
    bot_id = str(payload.get("channel_id") or payload.get("bot_id") or "")
    chat_type = str(payload.get("chat_type") or "")
    chat_id = str(payload.get("chat_id") or "") or None
    platform_user_id = str(payload.get("platform_user_id") or "")
    if platform not in IM_SOURCES or not bot_id:
        return None
    now = now_utc()
    if chat_type == "c2c" and chat_id is None:
        if not platform_user_id:
            return None
        return await _find_private_im_secret_prompt(
            db, user_id=user_id, payload=payload, now=now,
        )
    if chat_type == "group" and chat_id:
        return await _find_group_im_secret_prompt(
            db, user_id=user_id, payload=payload, now=now,
        )
    return None


async def _find_private_im_secret_prompt(
    db: AsyncSession,
    *,
    user_id: UUID,
    payload: dict,
    now: datetime,
) -> tuple[str, InteractionPrompt, McpSecretInput] | None:
    platform = str(payload.get("platform") or "")
    bot_id = str(payload.get("channel_id") or payload.get("bot_id") or "")
    platform_user_id = str(payload.get("platform_user_id") or "")
    rows = (await db.execute(
        select(McpSecretInput, InteractionPrompt)
        .join(InteractionPrompt, InteractionPrompt.id == McpSecretInput.prompt_id)
        .where(
            McpSecretInput.user_id == user_id,
            McpSecretInput.platform == platform,
            McpSecretInput.bot_id == bot_id,
            McpSecretInput.chat_type == "c2c",
            McpSecretInput.chat_id.is_(None),
            McpSecretInput.platform_user_id == platform_user_id,
            InteractionPrompt.user_id == user_id,
            InteractionPrompt.session_id == McpSecretInput.session_id,
        ).order_by(McpSecretInput.prompt_id.desc())
    )).all()
    event_id = str(payload.get("message_id") or payload.get("platform_message_id") or "")
    # 先跨同一 IM 私聊的短时 prompt 扫描重放 ID，再选择当前活动 prompt。
    # 否则旧消息重放可能被误认为新 prompt 的第一条凭据。
    if event_id:
        for stage, prompt in rows:
            if event_id in (stage.consumed_event_ids or []):
                return "replay", prompt, stage
    for stage, prompt in rows:
        if stage.status not in ACTIVE_STATES:
            continue
        mode = "private" if prompt.status == "active" and prompt.expires_at > now else "private_ended"
        return mode, prompt, stage
    return None


async def _find_group_im_secret_prompt(
    db: AsyncSession,
    *,
    user_id: UUID,
    payload: dict,
    now: datetime,
) -> tuple[str, InteractionPrompt, None] | None:
    platform = str(payload.get("platform") or "")
    bot_id = str(payload.get("channel_id") or payload.get("bot_id") or "")
    chat_id = str(payload.get("chat_id") or "")
    prompts = (await db.scalars(
        select(InteractionPrompt)
        .join(ConversationSession, ConversationSession.id == InteractionPrompt.session_id)
        .where(
            InteractionPrompt.user_id == user_id,
            InteractionPrompt.status == "active",
            InteractionPrompt.expires_at > now,
            ConversationSession.user_id == user_id,
            ConversationSession.source == platform,
            ConversationSession.bot_id == bot_id,
            ConversationSession.chat_type == "group",
            ConversationSession.chat_id == chat_id,
        ).order_by(InteractionPrompt.created_at.desc())
    )).all()
    for prompt in prompts:
        context = _schema(prompt).get("context")
        target = context.get("secret_target") if isinstance(context, dict) else None
        if isinstance(target, dict) and target.get("kind") == "mcp_credentials":
            return "group_blocked", prompt, None
    return None


async def cancel_mcp_secret_prompt_web(
    db: AsyncSession, *, prompt: InteractionPrompt, user_id: UUID,
) -> dict:
    """登录态 Web 取消；不依赖 IM 来源/群聊类型，授权只看 prompt owner。"""
    stored = await db.scalar(select(InteractionPrompt).where(
        InteractionPrompt.id == prompt.id,
        InteractionPrompt.user_id == user_id,
    ).with_for_update())
    if stored is None:
        raise HTTPException(status_code=404, detail="凭据输入不存在")
    schema = _schema(stored)
    context = schema.get("context") if isinstance(schema.get("context"), dict) else {}
    target = context.get("secret_target")
    if not schema.get("secret_fields") or not isinstance(target, dict) or target.get("kind") != "mcp_credentials":
        raise HTTPException(status_code=400, detail="当前交互不支持凭据取消")
    if stored.status != "active" or stored.expires_at <= now_utc():
        raise HTTPException(status_code=409, detail="凭据输入已结束")
    stage = await db.scalar(select(McpSecretInput).where(
        McpSecretInput.prompt_id == stored.id,
        McpSecretInput.user_id == user_id,
    ).with_for_update())
    if stage is not None and stage.status in ACTIVE_STATES:
        _clear_payload(stage, "cancelled")
    stored.status = "resolved"
    stored.resolved_at = now_utc()
    stored.schema_json = {**schema, "resolved_result": {
        "kind": stored.kind, "status": "cancelled", "prompt_id": stored.id,
        "option_id": "cancel", "value": None, "text": "已取消凭据输入",
    }}
    await db.flush()
    return {"ok": True, "prompt_id": stored.id, "status": "cancelled"}


async def cancel_active_secret_staging(
    db: AsyncSession,
    *,
    user_id,
    session_id: int,
) -> None:
    await db.execute(update(McpSecretInput).where(
        McpSecretInput.user_id == user_id,
        McpSecretInput.session_id == session_id,
        McpSecretInput.status.in_(tuple(ACTIVE_STATES)),
    ).values(
        status="cancelled",
        encrypted_payload="",
        payload_nonce="",
        encrypted_data_key="",
    ))


async def _bound_stage(
    db: AsyncSession,
    binding: McpSecretBinding,
) -> tuple[InteractionPrompt, McpSecretInput]:
    now = now_utc()
    prompt = await db.scalar(select(InteractionPrompt).where(
        InteractionPrompt.id == binding.prompt_id,
        InteractionPrompt.user_id == binding.user_id,
    ).with_for_update())
    if prompt is None:
        raise HTTPException(status_code=404, detail="凭据输入不存在")
    stage = await db.scalar(select(McpSecretInput).where(
        McpSecretInput.prompt_id == binding.prompt_id,
        McpSecretInput.user_id == binding.user_id,
        McpSecretInput.platform == binding.platform,
        McpSecretInput.bot_id == binding.bot_id,
        McpSecretInput.chat_type == binding.chat_type,
        McpSecretInput.chat_id == binding.chat_id,
        McpSecretInput.platform_user_id == binding.platform_user_id,
    ).with_for_update())
    if stage is None:
        raise HTTPException(status_code=404, detail="凭据输入不存在")
    context = _schema(prompt).get("context")
    target = context.get("secret_target") if isinstance(context, dict) else None
    try:
        target_server_id = UUID(str(target.get("server_id") or "")) if isinstance(target, dict) else None
    except (TypeError, ValueError, AttributeError):
        target_server_id = None
    if (
        prompt.session_id != stage.session_id
        or not isinstance(target, dict)
        or target.get("kind") != "mcp_credentials"
        or target_server_id != stage.server_id
        or not _schema(prompt).get("secret_fields")
    ):
        raise HTTPException(status_code=404, detail="凭据输入不存在")
    if stage.expires_at <= now or prompt.expires_at <= now:
        # 这里仅拒绝消费；后台 TTL 清理器负责在独立事务中标记 prompt 并回收密文。
        raise HTTPException(status_code=409, detail="凭据输入已过期")
    return prompt, stage


def _remember_event(stage: McpSecretInput, event_id: str) -> bool:
    """记录短期 webhook 去重键；缺失、过长或容量异常时 fail closed。"""
    event_id = str(event_id or "")
    if not event_id or len(event_id) > 200:
        raise HTTPException(status_code=400, detail="缺少有效的消息事件标识")
    seen = list(stage.consumed_event_ids or [])
    if event_id in seen:
        return False
    if len(seen) >= MAX_EVENT_IDS:
        raise HTTPException(status_code=409, detail="凭据输入事件过多，请重新发起")
    stage.consumed_event_ids = [*seen, event_id]
    return True


async def start_mcp_secret_input(
    db: AsyncSession,
    *,
    binding: McpSecretBinding,
    event_id: str,
) -> dict:
    prompt, stage = await _bound_stage(db, binding)
    if not _remember_event(stage, event_id):
        return {"status": "duplicate", "prompt_id": binding.prompt_id}
    if prompt.status != "active" or stage.status not in ACTIVE_STATES:
        return {"status": stage.status, "prompt_id": binding.prompt_id}
    if stage.status != "pending_choice":
        return {"status": "already_started", "prompt_id": binding.prompt_id}
    stage.status = "awaiting_secret"
    await db.flush()
    return {"status": "awaiting_secret", "prompt_id": binding.prompt_id, "field_index": 0}


async def cancel_mcp_secret_input(
    db: AsyncSession,
    *,
    binding: McpSecretBinding,
    event_id: str,
) -> dict:
    prompt, stage = await _bound_stage(db, binding)
    if not _remember_event(stage, event_id):
        return {"status": "duplicate", "prompt_id": binding.prompt_id}
    if stage.status == "cancelled":
        return {"status": "cancelled", "prompt_id": binding.prompt_id}
    if prompt.status != "active" or stage.status not in ACTIVE_STATES:
        raise HTTPException(status_code=409, detail="凭据输入已结束")
    _clear_payload(stage, "cancelled")
    prompt.status = "resolved"
    prompt.resolved_at = now_utc()
    prompt.schema_json = {**_schema(prompt), "resolved_result": {
        "kind": prompt.kind, "status": "cancelled", "prompt_id": prompt.id,
        "option_id": "cancel", "value": "cancel", "text": "已取消凭据输入",
    }}
    await db.flush()
    return {"status": "cancelled", "prompt_id": binding.prompt_id}


async def consume_mcp_secret_action(
    db: AsyncSession,
    *,
    user_id: UUID,
    prompt_id: int,
    token: str,
    event_id: str,
    platform: str,
    bot_id: str,
    platform_user_id: str,
    chat_type: str,
    chat_id: str | None,
) -> dict | None:
    """只消费绑定的私聊凭据按钮，绝不让通用 ask_user action 结束 secret prompt。"""
    from app.models import InteractionAction
    from app.services.interactions import _hash_token

    prompt = await db.scalar(select(InteractionPrompt).where(
        InteractionPrompt.id == prompt_id,
        InteractionPrompt.user_id == user_id,
    ).with_for_update())
    if prompt is None:
        return None
    schema = _schema(prompt)
    context = schema.get("context") if isinstance(schema.get("context"), dict) else {}
    target = context.get("secret_target")
    if not schema.get("secret_fields") or not isinstance(target, dict) or target.get("kind") != "mcp_credentials":
        return None
    action = await db.scalar(select(InteractionAction).where(
        InteractionAction.prompt_id == prompt_id,
        InteractionAction.token_hash == _hash_token(token),
    ).with_for_update())
    if action is None or action.expires_at <= now_utc():
        raise HTTPException(status_code=409, detail="凭据交互已结束")
    if action.status != "pending":
        if event_id and action.consumed_event_id == event_id:
            return {"status": "duplicate", "prompt_id": prompt_id}
        raise HTTPException(status_code=409, detail="凭据交互已结束")
    stage = await db.scalar(select(McpSecretInput).where(
        McpSecretInput.prompt_id == prompt_id,
        McpSecretInput.user_id == user_id,
        McpSecretInput.platform == platform,
        McpSecretInput.bot_id == bot_id,
        McpSecretInput.chat_type == "c2c",
        McpSecretInput.chat_id.is_(None),
        McpSecretInput.platform_user_id == platform_user_id,
    ).with_for_update())
    try:
        target_server_id = UUID(str(target.get("server_id") or "")) if isinstance(target, dict) else None
    except (TypeError, ValueError, AttributeError):
        target_server_id = None
    if (
        stage is None
        or chat_type != "c2c"
        or chat_id
        or prompt.session_id != stage.session_id
        or target_server_id != stage.server_id
        or stage.status not in ACTIVE_STATES
        or stage.expires_at <= now_utc()
        or prompt.status != "active"
        or action.option_id not in {"input_credentials", "cancel"}
    ):
        raise HTTPException(status_code=404, detail="凭据交互不存在")
    # 输入按钮只允许从等待选择态启动。若点击重放发生在已输入状态，
    # 不应先记录事件或消费 action，否则会留下未提交的部分状态变更。
    if action.option_id == "input_credentials" and stage.status != "pending_choice":
        return {"status": "already_started", "prompt_id": prompt_id}
    binding = McpSecretBinding(
        prompt_id=prompt_id, user_id=user_id, platform=platform, bot_id=bot_id,
        chat_type="c2c", chat_id=None, platform_user_id=platform_user_id,
    )
    if not _remember_event(stage, event_id):
        return {"status": "duplicate", "prompt_id": prompt_id}
    action.status = "consumed"
    action.consumed_at = now_utc()
    action.consumed_event_id = event_id
    if action.option_id == "cancel":
        result = await cancel_mcp_secret_input(db, binding=binding, event_id=f"{event_id}:cancel")
        await db.commit()
        return result
    stage.status = "awaiting_secret"
    await db.commit()
    return {"status": "awaiting_secret", "prompt_id": prompt_id, "field_index": 0}


def _resolve_secret_prompt(
    prompt: InteractionPrompt,
    stage: McpSecretInput,
    *,
    status: str,
    text: str,
) -> None:
    _clear_payload(stage, status)
    prompt.status = "resolved"
    prompt.resolved_at = now_utc()
    prompt.schema_json = {**_schema(prompt), "resolved_result": {
        "kind": prompt.kind, "status": status, "prompt_id": prompt.id,
        "option_id": None, "value": None, "text": text,
    }}


def _stage_field_value(
    stage: McpSecretInput,
    field: dict,
    value: str,
) -> dict[str, str]:
    one_value = validate_secret_values([field], {field["name"]: value})
    previous = {}
    if stage.encrypted_payload:
        previous = json.loads(decrypt_envelope(
            stage.encrypted_payload,
            stage.payload_nonce,
            stage.encrypted_data_key,
            key_version=stage.key_version,
        ))
    accumulated = {**previous, **one_value}
    ciphertext, nonce, wrapped_key = encrypt_envelope(
        json.dumps(accumulated, ensure_ascii=False), allow_empty=False,
    )
    stage.encrypted_payload = ciphertext
    stage.payload_nonce = nonce
    stage.encrypted_data_key = wrapped_key
    stage.key_version = 1
    stage.next_field_index += 1
    return accumulated


async def _commit_complete_secret(
    db: AsyncSession,
    *,
    stage: McpSecretInput,
    user_id: UUID,
    values: dict[str, str],
) -> bool:
    prompt = await db.get(InteractionPrompt, stage.prompt_id)
    if prompt is None or prompt.user_id != user_id or prompt.status != "active":
        _clear_payload(stage, "failed")
        return False
    server = await db.scalar(select(UserMcpServer).where(
        UserMcpServer.id == stage.server_id,
        UserMcpServer.user_id == user_id,
        UserMcpServer.scope == "user",
    ).with_for_update())
    if server is None:
        _resolve_secret_prompt(prompt, stage, status="failed", text="MCP 配置已失效，请重新发起")
        return False
    try:
        fields = [item for item in _schema(prompt).get("secret_fields", []) if isinstance(item, dict)]
        normalized = validate_secret_values(fields, values)
        from app.services.mcp_credentials import store_mcp_credentials_for_prompt

        await store_mcp_credentials_for_prompt(db, prompt, server, normalized)
    except (ValueError, HTTPException):
        _resolve_secret_prompt(prompt, stage, status="failed", text="凭据未能保存，请重新发起")
        return False
    _clear_payload(stage, "completed")
    return True


async def consume_mcp_secret_field(
    db: AsyncSession,
    *,
    binding: McpSecretBinding,
    event_id: str,
    value: str,
) -> dict:
    prompt, stage = await _bound_stage(db, binding)
    if not _remember_event(stage, event_id):
        return {"status": "duplicate", "prompt_id": binding.prompt_id}
    if prompt.status != "active" or stage.status not in ACTIVE_STATES:
        raise HTTPException(status_code=409, detail="凭据输入已结束")
    if stage.status != "awaiting_secret":
        raise HTTPException(status_code=409, detail="尚未开始凭据输入")
    fields = [item for item in _schema(prompt).get("secret_fields", []) if isinstance(item, dict)]
    index = int(stage.next_field_index or 0)
    if not fields or index >= len(fields):
        _resolve_secret_prompt(prompt, stage, status="failed", text="凭据输入无法继续，请重新发起")
        await db.flush()
        return {"status": "failed", "prompt_id": binding.prompt_id}
    try:
        values = _stage_field_value(stage, fields[index], value)
    except (ValueError, TypeError, InvalidTag, UnicodeError, binascii.Error):
        _resolve_secret_prompt(prompt, stage, status="failed", text="凭据字段无效，请重新发起")
        await db.flush()
        return {"status": "failed", "prompt_id": binding.prompt_id}
    if stage.next_field_index < len(fields):
        await db.flush()
        return {
            "status": "awaiting_secret", "prompt_id": binding.prompt_id,
            "field_index": stage.next_field_index,
            "field_label": str(fields[stage.next_field_index].get("label") or "凭据"),
        }
    completed = await _commit_complete_secret(
        db, stage=stage, user_id=binding.user_id, values=values,
    )
    await db.flush()
    return {"status": "completed" if completed else "failed", "prompt_id": binding.prompt_id}


async def cleanup_expired_mcp_secret_inputs(db: AsyncSession, *, now: datetime | None = None) -> int:
    """将到期的活动 prompt 置为 expired，并删除其密文 staging；可安全重复执行。"""
    current = now or now_utc()
    expired_ids = list((await db.scalars(select(McpSecretInput.prompt_id).where(
        McpSecretInput.expires_at <= current,
    ))).all())
    if not expired_ids:
        return 0
    prompts = list((await db.scalars(select(InteractionPrompt).where(
        InteractionPrompt.id.in_(expired_ids),
        InteractionPrompt.status == "active",
    ).with_for_update())).all())
    for prompt in prompts:
        prompt.status = "expired"
        prompt.resolved_at = current
        prompt.schema_json = {**_schema(prompt), "resolved_result": {
            "kind": prompt.kind, "status": "expired", "prompt_id": prompt.id,
            "option_id": None, "value": None, "text": "凭据输入已过期",
        }}
    result = await db.execute(delete(McpSecretInput).where(
        McpSecretInput.prompt_id.in_(expired_ids),
    ))
    await db.flush()
    return int(result.rowcount or 0)
