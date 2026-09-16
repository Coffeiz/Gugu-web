"""MCP secret prompt 的业务存储适配器。"""
from __future__ import annotations

import json
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.byok.crypto import encrypt_envelope
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import InteractionPrompt, User, UserMcpServer
from app.services.secret_prompts import resolved_prompt_result, validate_secret_values


async def consume_mcp_secret_prompt(
    prompt: InteractionPrompt,
    values: dict[str, str],
    *,
    user: User,
    db: AsyncSession,
) -> dict:
    """将通用 secret prompt 的值写入 MCP 统一加密凭据槽位。"""
    stored_prompt = await db.get(InteractionPrompt, prompt.id)
    if stored_prompt is None:
        raise HTTPException(status_code=404, detail="敏感信息输入不存在")
    schema = stored_prompt.schema_json if isinstance(stored_prompt.schema_json, dict) else {}
    fields = [item for item in (schema.get("secret_fields") or []) if isinstance(item, dict)]
    if not fields or stored_prompt.status != "active" or stored_prompt.expires_at <= now_utc():
        raise HTTPException(status_code=409, detail="敏感信息输入已过期")
    try:
        normalized = validate_secret_values(fields, values)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    context = schema.get("context") if isinstance(schema.get("context"), dict) else {}
    target = context.get("secret_target")
    server_id = str(target.get("server_id") or "") if isinstance(target, dict) else ""
    try:
        server_uuid = UUID(server_id)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=409, detail="敏感信息目标已失效")
    row = await get_owned(db, UserMcpServer, server_uuid, user.id)
    if row is None or row.scope != "user":
        raise HTTPException(status_code=404, detail="MCP server 不存在")

    slots = list(getattr(row, "credential_slots", None) or [])
    slot_ids = {str(item.get("id")) for item in slots if isinstance(item, dict)}
    if not slot_ids or set(normalized) != slot_ids:
        raise HTTPException(status_code=400, detail="凭据槽位不匹配")
    try:
        ciphertext, nonce, wrapped_key = encrypt_envelope(
            json.dumps(normalized, ensure_ascii=False), allow_empty=False,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="凭据加密失败") from exc
    row.encrypted_credentials = ciphertext
    row.credentials_nonce = nonce
    row.encrypted_credentials_key = wrapped_key
    row.credentials_key_version = 1
    stored_prompt.status = "resolved"
    stored_prompt.resolved_at = now_utc()
    stored_prompt.schema_json = {**schema, "resolved_result": resolved_prompt_result(stored_prompt.id)}
    await db.commit()
    from agent.mcp.manager import mcp_manager
    mcp_manager.invalidate_server(user.id, row.id)
    return {"ok": True, "prompt_id": stored_prompt.id}
