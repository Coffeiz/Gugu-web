"""MCP secret prompt 的业务存储适配器。"""
from __future__ import annotations

import json
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.byok.crypto import encrypt_envelope
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import InteractionRequest, McpSecretInput, User, UserMcpServer
from app.services.secret_prompts import resolved_prompt_result, validate_secret_values
from agent.mcp.credentials import validate_header_credentials


async def consume_mcp_secret_prompt(
    prompt: InteractionRequest,
    values: dict[str, str],
    *,
    user: User,
    db: AsyncSession,
) -> dict:
    """将通用 secret prompt 的值写入 MCP 统一加密凭据槽位。"""
    stored_prompt = await db.scalar(select(InteractionRequest).where(
        InteractionRequest.id == prompt.id,
        InteractionRequest.user_id == user.id,
    ).with_for_update())
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
    await store_mcp_credentials_for_prompt(db, stored_prompt, row, normalized)
    await db.commit()
    from agent.mcp.manager import mcp_manager
    mcp_manager.invalidate_server(user.id, row.id)
    return {"ok": True, "prompt_id": stored_prompt.id}


async def store_mcp_credentials_for_prompt(
    db: AsyncSession,
    prompt: InteractionRequest,
    server: UserMcpServer,
    normalized: dict[str, str],
) -> None:
    """在调用方事务内原子写入正式凭据并结束 secret prompt。

    Web 整表提交与 IM 密文 staging 收齐字段后共用此提交点；此函数不提交事务，
    便于凭据替换、prompt 终态和 staging 清理由入口放在同一事务中。
    """
    slot_ids = {
        str(item.get("id"))
        for item in (getattr(server, "credential_slots", None) or [])
        if isinstance(item, dict)
    }
    if not slot_ids or set(normalized) != slot_ids:
        raise HTTPException(status_code=400, detail="凭据槽位不匹配")
    try:
        validate_header_credentials(list(server.credential_slots or []), normalized)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        ciphertext, nonce, wrapped_key = encrypt_envelope(
            json.dumps(normalized, ensure_ascii=False), allow_empty=False,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="凭据加密失败") from exc
    schema = prompt.schema_json if isinstance(prompt.schema_json, dict) else {}
    server.encrypted_credentials = ciphertext
    server.credentials_nonce = nonce
    server.encrypted_credentials_key = wrapped_key
    server.credentials_key_version = 1
    prompt.status = "resolved"
    prompt.resolved_at = now_utc()
    prompt.schema_json = {**schema, "resolved_result": resolved_prompt_result(prompt.id)}
    staging = await db.scalar(
        select(McpSecretInput).where(McpSecretInput.prompt_id == prompt.id)
    )
    if staging is not None:
        staging.status = "completed"
        staging.encrypted_payload = ""
        staging.payload_nonce = ""
        staging.encrypted_data_key = ""
