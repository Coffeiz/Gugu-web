"""当前用户自助管理 MCP server 配置。

HTTP endpoint 和凭据槽位值都由服务端加密保存；敏感值通过通用 secret prompt 输入。
所有查询都绑定 ``user_id``，不接受模型传入的用户身份。
"""
from __future__ import annotations

from uuid import UUID

from agent.tools.base import BaseSkill, Tool


def _server_id(value: str) -> UUID:
    try:
        return UUID(str(value))
    except (ValueError, AttributeError, TypeError) as exc:
        raise ValueError("MCP server id 无效") from exc


def _mcp_call_mutates(args: dict) -> bool:
    """按 MCP 管理动作区分读写，避免 list/test_connection 触发核实循环。"""
    return str((args or {}).get("action") or "").strip() in {
        "add", "update", "enable", "disable", "remove",
    }


def _mcp_call_observes(args: dict) -> bool:
    """按 MCP 管理动作区分查询，允许复查轮在读操作后正常收束。"""
    return str((args or {}).get("action") or "").strip() in {
        "list", "test_connection",
    }


def _credential_prompt(server, action: str, slots: list[dict[str, str]]) -> dict:
    from agent.mcp.credentials import secret_fields

    return {
        "_interaction": "ask_user",
        "kind": "form",
        "title": "补全 MCP 凭据",
        "body": f"{action} MCP 服务 [{server.name}] 需要以下凭据。值只会加密保存，不会写入聊天记录。",
        "options": [],
        "secret_fields": secret_fields(slots),
        "secret_target": {"kind": "mcp_credentials", "server_id": str(server.id)},
    }


async def _manage_mcp_servers(db, user_id, args: dict):
    from sqlalchemy import select

    from agent.mcp.manager import McpToolManager, mcp_manager
    from app.api.v1.mcp_settings import (
        _check_endpoint,
        agent_safe_server_view,
        _with_runtime_state,
        _validate_common,
        _validate_name,
    )
    from app.core.config import get_settings
    from app.byok.crypto import encrypt_envelope
    from app.models import UserMcpServer

    action = str(args.get("action") or "").strip()
    if action == "list":
        settings = get_settings()
        rows = (await db.execute(
            select(UserMcpServer).where(
                UserMcpServer.user_id == user_id,
                UserMcpServer.scope == "user",
            ).order_by(UserMcpServer.created_at)
        )).scalars().all()
        if settings.mcp.enabled:
            await mcp_manager.list_user_tools(user_id)
        states = {item["server_id"]: item for item in mcp_manager.server_states(user_id)}
        items = []
        for row in rows:
            items.append(_with_runtime_state(
                agent_safe_server_view(row), states.get(str(row.id)),
            ))
        return {"enabled": settings.mcp.enabled, "items": items}

    server = None
    if action not in {"list", "add"}:
        server_id_value = str(args.get("server_id") or "").strip()
        server_name = str(args.get("name") or "").strip()
        if server_id_value:
            try:
                server_id = _server_id(server_id_value)
            except ValueError as exc:
                return {"error": str(exc)}
            server = await db.scalar(select(UserMcpServer).where(
                UserMcpServer.id == server_id,
                UserMcpServer.user_id == user_id,
                UserMcpServer.scope == "user",
            ))
        elif server_name:
            # list 返回的 id 是最可靠的定位方式，但名称在用户范围内唯一；
            # 接受名称可以让模型直接复用刚刚列出的结果，避免把 name 误塞进 UUID。
            server = await db.scalar(select(UserMcpServer).where(
                UserMcpServer.name == server_name,
                UserMcpServer.user_id == user_id,
                UserMcpServer.scope == "user",
            ))
        else:
            return {"error": "需要提供 server_id 或 name"}

    if action == "add":
        name = _validate_name(str(args.get("name") or ""))
        transport = str(args.get("transport") or "http")
        endpoint = _check_endpoint(str(args.get("endpoint") or "")) if transport == "http" else ""
        command = str(args.get("command") or "").strip() if transport == "stdio" else ""
        if transport not in {"http", "stdio"}:
            return {"error": "transport 只支持 http / stdio"}
        if transport == "stdio" and not command:
            return {"error": "stdio MCP server 必须填写启动命令"}
        settings = get_settings()
        _validate_common(
            str(args.get("confirm_mode") or "confirm_all"),
            int(args.get("timeout_seconds") or settings.mcp.default_timeout_seconds),
            list(args.get("tool_allowlist") or []),
        )
        existing = (await db.execute(select(UserMcpServer.id).where(
            UserMcpServer.user_id == user_id, UserMcpServer.scope == "user", UserMcpServer.name == name,
        ))).scalar_one_or_none()
        if existing is not None:
            return {"error": f"名称 {name} 已存在"}
        count = (await db.execute(select(UserMcpServer.id).where(
            UserMcpServer.user_id == user_id, UserMcpServer.scope == "user",
        ))).scalars().all()
        if len(count) >= settings.mcp.max_servers_per_user:
            return {"error": f"每个用户最多添加 {settings.mcp.max_servers_per_user} 个 MCP server"}
        from agent.interactions.confirmations import needs_confirmation, target_confirmation_identity

        summary = f"添加 MCP server [{name}]"
        gate = needs_confirmation(args, summary, user_id, identity=target_confirmation_identity("mcp.add", {"server": [name]}))
        if gate is not None:
            return gate
        endpoint_ciphertext = endpoint_nonce = endpoint_wrapped_key = ""
        if transport == "http":
            try:
                endpoint_ciphertext, endpoint_nonce, endpoint_wrapped_key = encrypt_envelope(endpoint, allow_empty=False)
            except ValueError:
                return {"error": "endpoint 加密失败"}
        try:
            from agent.mcp.credentials import normalize_slots
            credential_slots = normalize_slots(args.get("credential_slots"))
        except ValueError as exc:
            return {"error": str(exc)}
        row = UserMcpServer(
            user_id=user_id, scope="user", name=name, transport=transport, endpoint="",
            encrypted_endpoint=endpoint_ciphertext, endpoint_nonce=endpoint_nonce,
            encrypted_endpoint_key=endpoint_wrapped_key,
            credential_slots=credential_slots,
            command=command,
            enabled=bool(args.get("enabled", True)),
            confirm_mode=str(args.get("confirm_mode") or "confirm_all"),
            timeout_seconds=int(args.get("timeout_seconds") or settings.mcp.default_timeout_seconds),
            tool_allowlist=list(args.get("tool_allowlist") or []),
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        result = {"success": True, "server": agent_safe_server_view(row)}
        if credential_slots:
            result.update(_credential_prompt(row, "添加", credential_slots))
        return result

    if server is None:
        return {"error": "MCP server 不存在或不属于当前账号"}

    if action == "update":
        settings = get_settings()
        if "name" in args and args.get("name") and str(args["name"]).strip() != server.name:
            new_name = _validate_name(str(args["name"]))
            conflict = (await db.execute(select(UserMcpServer.id).where(
                UserMcpServer.user_id == user_id,
                UserMcpServer.scope == "user",
                UserMcpServer.name == new_name,
                UserMcpServer.id != server.id,
            ))).scalar_one_or_none()
            if conflict is not None:
                return {"error": f"名称 {new_name} 已存在"}
            server.name = new_name

        next_transport = str(args.get("transport") or server.transport)
        if next_transport not in {"http", "stdio"}:
            return {"error": "transport 只支持 http / stdio"}
        endpoint = str(args.get("endpoint")) if "endpoint" in args else McpToolManager._config_from_row(server).endpoint
        command = str(args.get("command")) if "command" in args else server.command
        if "transport" in args or "endpoint" in args or "command" in args:
            if next_transport == "http":
                endpoint = _check_endpoint(endpoint)
                command = ""
            else:
                command = command.strip()
                if not command:
                    return {"error": "stdio MCP server 必须填写启动命令"}
                endpoint = ""
            server.transport, server.command = next_transport, command
            if next_transport == "http":
                try:
                    server.encrypted_endpoint, server.endpoint_nonce, server.encrypted_endpoint_key = encrypt_envelope(endpoint, allow_empty=False)
                except ValueError:
                    return {"error": "endpoint 加密失败"}
                server.endpoint_key_version = 1
            else:
                server.endpoint = ""
                server.encrypted_endpoint = ""
                server.endpoint_nonce = ""
                server.encrypted_endpoint_key = ""

        if "confirm_mode" in args or "timeout_seconds" in args or "tool_allowlist" in args:
            confirm_mode = str(args.get("confirm_mode")) if "confirm_mode" in args else server.confirm_mode
            timeout_seconds = int(args.get("timeout_seconds")) if "timeout_seconds" in args else server.timeout_seconds
            tool_allowlist = list(args.get("tool_allowlist")) if "tool_allowlist" in args else list(server.tool_allowlist or [])
            _validate_common(confirm_mode, timeout_seconds, tool_allowlist)
            server.confirm_mode, server.timeout_seconds = confirm_mode, timeout_seconds
            server.tool_allowlist = tool_allowlist
        if "enabled" in args:
            server.enabled = bool(args["enabled"])
        credential_slots = None
        if "credential_slots" in args:
            try:
                from agent.mcp.credentials import normalize_slots
                credential_slots = normalize_slots(args.get("credential_slots"))
            except ValueError as exc:
                return {"error": str(exc)}
            server.credential_slots = credential_slots
            server.encrypted_credentials = ""
            server.credentials_nonce = ""
            server.encrypted_credentials_key = ""
            server.credentials_key_version = 1

        await db.commit()
        await db.refresh(server)
        mcp_manager.invalidate_server(user_id, server.id)
        result = {"success": True, "server": agent_safe_server_view(server)}
        if credential_slots:
            result.update(_credential_prompt(server, "更新", credential_slots))
        return result

    if action in {"enable", "disable"}:
        server.enabled = action == "enable"
        await db.flush()
        mcp_manager.invalidate_server(user_id, server.id)
        if server.enabled:
            config = McpToolManager._config_from_row(server)
            runtime = await mcp_manager.refresh_config(config)
            if runtime is None or runtime.effective_state() != "ok":
                return {
                    "success": True,
                    "server": agent_safe_server_view(server),
                    "state": runtime.effective_state() if runtime else "unloaded",
                    "tool_count": 0,
                    "error": runtime.last_error if runtime else "MCP 工具加载失败",
                }
        return {"success": True, "server": agent_safe_server_view(server)}

    if action == "remove":
        from agent.interactions.confirmations import needs_confirmation, target_confirmation_identity

        summary = f"删除 MCP server [{server.name}]"
        gate = needs_confirmation(args, summary, user_id, identity=target_confirmation_identity("mcp.remove", {"server": [str(server.id)]}))
        if gate is not None:
            return gate
        server_id = server.id
        await db.delete(server)
        await db.flush()
        mcp_manager.invalidate_server(user_id, server_id)
        return {"success": True, "server_id": str(server_id), "message": "MCP server 已删除。"}

    if action == "test_connection":
        config = McpToolManager._config_from_row(server)
        runtime = await mcp_manager.refresh_config(config)
        state = runtime.effective_state() if runtime else "unloaded"
        tool_count = len(runtime.tools) if runtime and state == "ok" else 0
        return {
            "ok": state == "ok",
            "tool_count": tool_count,
            "tools": sorted(runtime.tools) if runtime and state == "ok" else [],
            "error": runtime.last_error if runtime and state != "ok" else None,
            "message": "连接成功。" if state == "ok" else None,
        }

    return {"error": "action 只支持 list / add / update / enable / disable / remove / test_connection"}


class McpSkill(BaseSkill):
    name = "mcp-management"
    tools = [Tool(
        name="manage_mcp_servers",
        label="管理 MCP 服务",
        description_short="管理当前账号的 MCP server 配置",
        description=(
            "管理当前账号自己的 MCP server。支持 list、add、update、enable、disable、remove、test_connection。"
            "除 list/add 外的动作优先使用 server_id；也可以使用 list 返回的唯一 name 定位服务。"
            "HTTP 服务通过 credential_slots 描述凭据注入位置（header 或 query）；"
            "凭据值不会出现在工具参数中，而是在需要时通过通用加密输入交互收集。"
            "add 和 remove 会要求用户确认（enable/disable 可逆、不设门）；list 会返回当前运行时已加载的工具名；为空时只能核对保存的配置，不能证明网络连接或凭据有效，必须以 test_connection 成功为准。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "add", "update", "enable", "disable", "remove", "test_connection"]},
                "server_id": {"type": "string", "maxLength": 64},
                "name": {"type": "string", "maxLength": 64},
                "endpoint": {"type": "string", "maxLength": 1000},
                "transport": {"type": "string", "enum": ["http", "stdio"]},
                "command": {"type": "string", "maxLength": 1000},
                "credential_slots": {
                    "type": "array", "maxItems": 16,
                    "items": {
                        "type": "object", "additionalProperties": False,
                        "properties": {
                            "id": {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},
                            "label": {"type": "string", "maxLength": 120},
                            "target": {"type": "string", "enum": ["header", "query"]},
                            "name": {"type": "string", "maxLength": 256},
                            "prefix": {"type": "string", "maxLength": 120},
                        },
                        "required": ["id", "label", "target", "name"],
                    },
                },
                "enabled": {"type": "boolean"},
                "confirm_mode": {"type": "string", "enum": ["auto", "confirm_all"]},
                "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 300},
                "tool_allowlist": {"type": "array", "maxItems": 32, "items": {"type": "string", "maxLength": 128}},
                "confirm": {"type": "boolean"},
                "confirm_code": {"type": "string", "maxLength": 64},
            },
            "required": ["action"],
            "additionalProperties": False,
        },
        handler=_manage_mcp_servers,
        mutates=True,
        mutates_for_input=_mcp_call_mutates,
        observes_for_input=_mcp_call_observes,
        requires_confirmation=True,
    )]


McpSkill().register()
