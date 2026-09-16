"""用户侧 MCP server 配置接口（PRD-MCP-1 FR-MCP-1/4/6）。

- CRUD + 连接测试 + 已载入工具列表；越权访问他人 server 一律 404。
- endpoint 属不可信外部地址：保存/更新时强制 url_is_safe 前置校验；
  凭据只保存注入槽位，敏感值通过通用 secret prompt 单独加密落库。
- 上限：每用户 server 数、单 server 工具白名单长度；超限返回人话 400。
"""
from __future__ import annotations

import logging
import re
from urllib.parse import parse_qsl, urlsplit
from uuid import UUID
from typing import Literal

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
from app.core.tz import now_utc
from app.db.session import get_db
from app.models import User, UserMcpServer

_log = logging.getLogger("app.mcp_settings")

router = APIRouter(prefix="/mcp", tags=["mcp"])

_NAME_MAX = 64
_TIMEOUT_MIN, _TIMEOUT_MAX = 1, 300
_CONFIRM_MODES = ("auto", "confirm_all")


class McpServerCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=_NAME_MAX)
    transport: Literal["http", "stdio"] = "http"
    endpoint: str = Field(default="", max_length=1000)
    command: str = Field(default="", max_length=1000)
    credential_slots: list[dict] = Field(default_factory=list)
    enabled: bool = True
    confirm_mode: str = "confirm_all"
    timeout_seconds: int = 30
    tool_allowlist: list[str] = Field(default_factory=list)


class McpServerPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=_NAME_MAX)
    transport: Literal["http", "stdio"] | None = None
    # 非当前传输方式的字段会由前端以空字符串提交；真正的必填校验在
    # _validate_transport 中按 transport 执行，避免 Pydantic 先误报最小长度。
    endpoint: str | None = Field(None, max_length=1000)
    command: str | None = Field(None, max_length=1000)
    credential_slots: list[dict] | None = None
    enabled: bool | None = None
    confirm_mode: str | None = None
    timeout_seconds: int | None = None
    tool_allowlist: list[str] | None = None


@router.get("/status")
async def mcp_status(user: User = Depends(get_current_user)):
    """返回平台 MCP 入口状态；不触发任何 server 连接。"""
    return {"enabled": get_settings().mcp.enabled}


def _validate_name(name: str) -> str:
    name = (name or "").strip()
    if not re.fullmatch(r"[\w]{1,64}", name, flags=re.UNICODE):
        raise HTTPException(
            status_code=400,
            detail="名称只能包含中文、字母、数字和下划线（1-64 位）",
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


def _validate_transport(transport: str, endpoint: str, command: str) -> tuple[str, str, str]:
    if transport == "http":
        return transport, _check_endpoint(endpoint), ""
    command = (command or "").strip()
    if not command:
        raise HTTPException(status_code=400, detail="stdio MCP server 必须填写启动命令")
    if "\x00" in command:
        raise HTTPException(status_code=400, detail="stdio 启动命令无效")
    return transport, "", command


def _decrypt_endpoint(row: UserMcpServer) -> str:
    if not row.encrypted_endpoint:
        return row.endpoint
    try:
        return decrypt_envelope(
            row.encrypted_endpoint, row.endpoint_nonce, row.encrypted_endpoint_key,
            key_version=row.endpoint_key_version,
        )
    except Exception:
        return ""


def _server_view(row: UserMcpServer, settings=None) -> dict:
    """返回 MCP 编辑视图；敏感值不回显，只返回槽位和配置状态。"""
    endpoint_query_has_value = any(
        "{{secret:" not in value
        for _key, value in parse_qsl(urlsplit(_decrypt_endpoint(row)).query, keep_blank_values=True)
    )
    return {
        "id": str(row.id),
        "name": row.name,
        "scope": row.scope,
        "transport": row.transport,
        "endpoint": _decrypt_endpoint(row),
        "command": row.command,
        "credential_slots": list(getattr(row, "credential_slots", None) or []),
        "credential_state": {
            "configured": bool(
                getattr(row, "encrypted_credentials", "")
                or row.encrypted_headers
                or row.encrypted_query_params
            ),
            "slot_ids": [str(item.get("id")) for item in (getattr(row, "credential_slots", None) or []) if isinstance(item, dict)],
        },
        "has_credentials": bool(
            getattr(row, "encrypted_credentials", "")
            or row.encrypted_headers
            or row.encrypted_query_params
            or endpoint_query_has_value
        ),
        "enabled": row.enabled,
        "confirm_mode": row.confirm_mode,
        "timeout_seconds": row.timeout_seconds,
        "tool_allowlist": list(row.tool_allowlist or []),
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _with_runtime_state(view: dict, state: dict | None) -> dict:
    """把当前 worker 的运行时状态合并到统一的 server 视图。"""
    view["state"] = state["state"] if state else "unloaded"
    view["loaded_tool_count"] = state["tool_count"] if state else 0
    view["loaded_tool_names"] = state["tool_names"] if state else []
    return view


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

    # 运行时工具缓存在 worker 内；列表页不能只读本进程旧缓存，否则咕咕
    # 刚在另一个 worker 装载成功时，这里仍会显示 0 个工具。已启用服务
    # 在没有有效缓存时会按需执行一次 tools/list，之后仍复用缓存。
    if settings.mcp.enabled:
        await mcp_manager.list_user_tools(user.id)
    states = {s["server_id"]: s for s in mcp_manager.server_states(user.id)}
    items = []
    for row in rows:
        items.append(_with_runtime_state(
            _server_view(row, settings), states.get(str(row.id)),
        ))
    return {"enabled": settings.mcp.enabled, "max_servers": settings.mcp.max_servers_per_user,
            "items": items}


@router.post("/servers")
async def create_server(payload: McpServerCreate, user: User = Depends(get_current_user),
                        db: AsyncSession = Depends(get_db)):
    settings = get_settings()
    name = _validate_name(payload.name)
    _validate_common(payload.confirm_mode, payload.timeout_seconds, payload.tool_allowlist)
    transport, endpoint, command = _validate_transport(
        payload.transport, payload.endpoint, payload.command,
    )
    from agent.mcp.credentials import normalize_slots
    try:
        credential_slots = normalize_slots(payload.credential_slots)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

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

    endpoint_ciphertext = endpoint_nonce = endpoint_wrapped_key = ""
    if transport == "http":
        try:
            endpoint_ciphertext, endpoint_nonce, endpoint_wrapped_key = encrypt_envelope(endpoint, allow_empty=False)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="endpoint 加密失败") from exc

    row = UserMcpServer(
        user_id=user.id, scope="user", name=name, transport=transport,
        endpoint="", encrypted_endpoint=endpoint_ciphertext, endpoint_nonce=endpoint_nonce,
        encrypted_endpoint_key=endpoint_wrapped_key, command=command,
        enabled=payload.enabled,
        credential_slots=credential_slots,
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
    next_transport = payload.transport or row.transport
    if payload.transport is not None or payload.endpoint is not None or payload.command is not None:
        endpoint = payload.endpoint if payload.endpoint is not None else _decrypt_endpoint(row)
        command = payload.command if payload.command is not None else row.command
        row.transport, endpoint, row.command = _validate_transport(next_transport, endpoint, command)
        if next_transport == "http":
            try:
                row.encrypted_endpoint, row.endpoint_nonce, row.encrypted_endpoint_key = encrypt_envelope(endpoint, allow_empty=False)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="endpoint 加密失败") from exc
            row.endpoint_key_version = 1
        row.endpoint = ""
    if payload.credential_slots is not None:
        from agent.mcp.credentials import normalize_slots
        try:
            row.credential_slots = normalize_slots(payload.credential_slots)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
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
    from agent.mcp.manager import McpToolManager, mcp_manager

    row = await _get_owned_server(db, server_id, user)
    config = McpToolManager._config_from_row(row)
    runtime = await mcp_manager.refresh_config(config)
    if runtime is None or runtime.effective_state() != "ok":
        return {
            "ok": False,
            "error": (runtime.last_error if runtime else "MCP server 未能建立连接"),
            "tools": [],
        }
    tool_names = [meta.tool_name for meta in runtime.metas.values()]
    return {"ok": True, "tool_count": len(tool_names), "tools": tool_names[:64]}


@router.post("/servers/{server_id}/reconnect")
async def reconnect_server(server_id: str, user: User = Depends(get_current_user),
                           db: AsyncSession = Depends(get_db)):
    """清除指定 server 的运行时缓存并立即重新发现工具。"""
    row = await _get_owned_server(db, server_id, user)
    from agent.mcp.manager import McpToolManager, mcp_manager

    config = McpToolManager._config_from_row(row)
    runtime = await mcp_manager.refresh_config(config)
    state = runtime.effective_state() if runtime else "unloaded"
    tool_count = len(runtime.tools) if runtime and state == "ok" else 0
    return {
        "ok": state == "ok",
        "state": state,
        "tool_count": tool_count,
        "total_loaded": tool_count,
        "tool_names": sorted(runtime.tools) if runtime and state == "ok" else [],
        "error": runtime.last_error if runtime and state != "ok" else None,
    }


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
