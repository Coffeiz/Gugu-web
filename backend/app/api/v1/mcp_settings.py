"""用户侧 MCP server 配置接口（PRD-MCP-1 FR-MCP-1/4/6）。

- CRUD + 连接测试 + 已载入工具列表；越权访问他人 server 一律 404。
- endpoint 属不可信外部地址：保存/更新时强制 url_is_safe 前置校验；
  凭据（请求头）整体信封加密落库，接口只回显掩码。
- 上限：每用户 server 数、单 server 工具白名单长度；超限返回人话 400。
"""
from __future__ import annotations

import json
import logging
import re

import sqlalchemy as sa
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.byok.crypto import decrypt_envelope, encrypt_envelope
from app.core.config import get_settings
from app.core.ownership import get_owned
from app.core.security import get_current_user
from app.core.url_security import url_is_safe
from app.db.session import get_db
from app.models import User, UserMcpServer

_log = logging.getLogger("app.mcp_settings")

router = APIRouter(prefix="/mcp", tags=["mcp"])

_NAME_MAX = 64
_TIMEOUT_MIN, _TIMEOUT_MAX = 1, 300
_CONFIRM_MODES = ("auto", "confirm_all")


class McpServerCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=_NAME_MAX)
    endpoint: str = Field(..., min_length=1, max_length=1000)
    headers: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
    confirm_mode: str = "confirm_all"
    timeout_seconds: int = 30
    tool_allowlist: list[str] = Field(default_factory=list)


class McpServerPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=_NAME_MAX)
    endpoint: str | None = Field(None, min_length=1, max_length=1000)
    # None=不修改；{}=清空凭据
    headers: dict[str, str] | None = None
    enabled: bool | None = None
    confirm_mode: str | None = None
    timeout_seconds: int | None = None
    tool_allowlist: list[str] | None = None


def _validate_name(name: str) -> str:
    name = (name or "").strip()
    if not re.fullmatch(r"[a-zA-Z0-9_]{1,64}", name):
        raise HTTPException(
            status_code=400,
            detail="名称只能包含字母、数字和下划线（1-64 位），作为工具命名空间使用",
        )
    return name


def _validate_common(confirm_mode: str | None, timeout_seconds: int | None,
                     tool_allowlist: list[str] | None) -> None:
    settings = get_settings()
    if confirm_mode is not None and confirm_mode not in _CONFIRM_MODES:
        raise HTTPException(status_code=400, detail="确认模式只支持 auto / confirm_all")
    if timeout_seconds is not None and not (_TIMEOUT_MIN <= timeout_seconds <= _TIMEOUT_MAX):
        raise HTTPException(
            status_code=400,
            detail=f"超时秒数需在 {_TIMEOUT_MIN}-{_TIMEOUT_MAX} 之间",
        )
    if tool_allowlist is not None:
        if len(tool_allowlist) > settings.mcp.max_tools_per_server:
            raise HTTPException(
                status_code=400,
                detail=f"工具白名单最多 {settings.mcp.max_tools_per_server} 个工具",
            )
        if any(not isinstance(t, str) or not t.strip() for t in tool_allowlist):
            raise HTTPException(status_code=400, detail="白名单工具名不能为空")


def _check_endpoint(endpoint: str) -> str:
    endpoint = (endpoint or "").strip()
    reason = url_is_safe(endpoint)
    if reason:
        raise HTTPException(status_code=400, detail=f"endpoint 校验失败：{reason}")
    return endpoint


def _server_view(row: UserMcpServer, settings=None) -> dict:
    """掩码视图：凭据只回显键名，值一律 ••••。"""
    headers: dict[str, str] = {}
    if row.encrypted_headers:
        try:
            raw = decrypt_envelope(
                row.encrypted_headers, row.headers_nonce, row.encrypted_headers_key,
                key_version=row.headers_key_version,
            )
            decoded = json.loads(raw)
            if isinstance(decoded, dict):
                headers = {str(k): "••••" for k in decoded}
        except Exception:
            headers = {"(加密数据)": "••••"}
    return {
        "id": str(row.id),
        "name": row.name,
        "scope": row.scope,
        "transport": row.transport,
        "endpoint": row.endpoint,
        "headers": headers,
        "has_credentials": bool(row.encrypted_headers),
        "enabled": row.enabled,
        "confirm_mode": row.confirm_mode,
        "timeout_seconds": row.timeout_seconds,
        "tool_allowlist": list(row.tool_allowlist or []),
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _invalidate(user_id, server_id) -> None:
    """配置变更即时生效：清掉该 server 的工具缓存（FR-MCP-5）。"""
    from agent.mcp.manager import mcp_manager

    mcp_manager.invalidate_server(user_id, server_id)


@router.get("/servers")
async def list_servers(user: User = Depends(get_current_user),
                       db: AsyncSession = Depends(get_db)):
    settings = get_settings()
    rows = (await db.execute(
        select(UserMcpServer).where(
            UserMcpServer.user_id == user.id,
            UserMcpServer.scope == "user",
        ).order_by(UserMcpServer.created_at)
    )).scalars().all()
    from agent.mcp.manager import mcp_manager

    states = {s["server_id"]: s for s in mcp_manager.server_states(user.id)}
    items = []
    for row in rows:
        view = _server_view(row, settings)
        state = states.get(str(row.id))
        view["state"] = state["state"] if state else "unloaded"
        view["loaded_tool_count"] = state["tool_count"] if state else 0
        items.append(view)
    return {"enabled": settings.mcp.enabled, "max_servers": settings.mcp.max_servers_per_user,
            "items": items}


@router.post("/servers")
async def create_server(payload: McpServerCreate, user: User = Depends(get_current_user),
                        db: AsyncSession = Depends(get_db)):
    settings = get_settings()
    name = _validate_name(payload.name)
    _validate_common(payload.confirm_mode, payload.timeout_seconds, payload.tool_allowlist)
    endpoint = _check_endpoint(payload.endpoint)

    existing = (await db.execute(
        select(UserMcpServer.id).where(
            UserMcpServer.user_id == user.id,
            UserMcpServer.scope == "user",
            UserMcpServer.name == name,
        )
    )).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=400, detail=f"名称 {name} 已存在")
    count = (await db.execute(
        select(sa.func.count()).select_from(UserMcpServer).where(
            UserMcpServer.user_id == user.id, UserMcpServer.scope == "user")
    )).scalar_one()
    if count >= settings.mcp.max_servers_per_user:
        raise HTTPException(
            status_code=400,
            detail=f"每个用户最多添加 {settings.mcp.max_servers_per_user} 个 MCP server",
        )

    try:
        ciphertext, nonce, wrapped_key = encrypt_envelope(
            json.dumps(payload.headers, ensure_ascii=False), allow_empty=True,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    row = UserMcpServer(
        user_id=user.id, scope="user", name=name, transport="http",
        endpoint=endpoint, encrypted_headers=ciphertext, headers_nonce=nonce,
        encrypted_headers_key=wrapped_key, enabled=payload.enabled,
        confirm_mode=payload.confirm_mode or "confirm_all",
        timeout_seconds=payload.timeout_seconds or settings.mcp.default_timeout_seconds,
        tool_allowlist=list(payload.tool_allowlist or []),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    _log.info("MCP server 配置已保存：user=%s server=%s", str(user.id)[:8], name)
    return _server_view(row, settings)


async def _get_owned_server(db: AsyncSession, server_id: str, user: User) -> UserMcpServer:
    try:
        from uuid import UUID as _UUID

        parsed = _UUID(server_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="MCP server 不存在")
    row = await get_owned(db, UserMcpServer, parsed, user.id)
    if row is None:
        raise HTTPException(status_code=404, detail="MCP server 不存在")
    return row


@router.patch("/servers/{server_id}")
async def update_server(server_id: str, payload: McpServerPatch,
                        user: User = Depends(get_current_user),
                        db: AsyncSession = Depends(get_db)):
    row = await _get_owned_server(db, server_id, user)
    settings = get_settings()
    _validate_common(payload.confirm_mode, payload.timeout_seconds, payload.tool_allowlist)

    if payload.name is not None and payload.name != row.name:
        new_name = _validate_name(payload.name)
        conflict = (await db.execute(
            select(UserMcpServer.id).where(
                UserMcpServer.user_id == user.id,
                UserMcpServer.scope == "user",
                UserMcpServer.name == new_name,
                UserMcpServer.id != row.id,
            )
        )).scalar_one_or_none()
        if conflict is not None:
            raise HTTPException(status_code=400, detail=f"名称 {new_name} 已存在")
        row.name = new_name
    if payload.endpoint is not None:
        row.endpoint = _check_endpoint(payload.endpoint)
    if payload.headers is not None:
        if payload.headers:
            try:
                ciphertext, nonce, wrapped_key = encrypt_envelope(
                    json.dumps(payload.headers, ensure_ascii=False), allow_empty=True,
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            row.encrypted_headers, row.headers_nonce = ciphertext, nonce
            row.encrypted_headers_key, row.headers_key_version = wrapped_key, 1
        else:
            # 空对象表示主动清除凭据；不能把“空 JSON”继续加密保存，否则
            # 列表接口仍会误报 has_credentials=true。
            row.encrypted_headers = ""
            row.headers_nonce = ""
            row.encrypted_headers_key = ""
            row.headers_key_version = 1
    if payload.enabled is not None:
        row.enabled = payload.enabled
    if payload.confirm_mode is not None:
        row.confirm_mode = payload.confirm_mode
    if payload.timeout_seconds is not None:
        row.timeout_seconds = payload.timeout_seconds
    if payload.tool_allowlist is not None:
        row.tool_allowlist = list(payload.tool_allowlist)

    await db.commit()
    await db.refresh(row)
    _invalidate(user.id, row.id)
    _log.info("MCP server 配置已更新：user=%s server=%s", str(user.id)[:8], row.name)
    return _server_view(row, settings)


@router.delete("/servers/{server_id}")
async def delete_server(server_id: str, user: User = Depends(get_current_user),
                        db: AsyncSession = Depends(get_db)):
    row = await _get_owned_server(db, server_id, user)
    name = row.name
    await db.delete(row)
    await db.commit()
    _invalidate(user.id, row.id)
    _log.info("MCP server 配置已删除：user=%s server=%s", str(user.id)[:8], name)
    return {"deleted": True, "id": server_id}


@router.post("/servers/{server_id}/test_connection")
async def test_connection(server_id: str, user: User = Depends(get_current_user),
                          db: AsyncSession = Depends(get_db)):
    """连接测试：initialize + tools/list，返回人话结果与工具数（FR-MCP-6）。"""
    from agent.mcp.client import McpClient
    from agent.mcp.manager import McpToolManager, mcp_manager

    row = await _get_owned_server(db, server_id, user)
    config = McpToolManager._config_from_row(row)
    client = McpClient(config.endpoint, headers=config.headers,
                       timeout_seconds=float(config.timeout_seconds))
    listing = await client.list_tools()
    if "error" in listing:
        _invalidate(user.id, row.id)
        return {"ok": False, "error": listing["error"]}
    tool_names = [str(t.get("name") or "") for t in listing.get("tools") or []]
    return {"ok": True, "tool_count": len(tool_names), "tools": tool_names[:64]}


@router.get("/servers/{server_id}/tools")
async def list_loaded_tools(server_id: str, user: User = Depends(get_current_user),
                            db: AsyncSession = Depends(get_db)):
    """当前进程内已载入的工具（状态可见性，FR-MCP-6）。"""
    from agent.mcp.manager import mcp_manager

    row = await _get_owned_server(db, server_id, user)
    server_id_str = str(row.id)
    state = next(
        (s for s in mcp_manager.server_states(user.id) if s["server_id"] == server_id_str),
        None,
    )
    return {
        "server_id": server_id_str,
        "state": state["state"] if state else "unloaded",
        "loaded_tool_count": state["tool_count"] if state else 0,
        "last_error": state["last_error"] if state else None,
    }
