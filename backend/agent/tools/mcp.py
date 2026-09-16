"""当前用户自助管理 MCP server 配置。

凭据不经过这个工具：add 只写非敏感配置，secret 字段由 Phase 2 的独立
pending 凭据通道处理。所有查询都绑定 ``user_id``，不接受模型传入的用户身份。
"""
from __future__ import annotations

from uuid import UUID

from agent.tools.base import BaseSkill, Tool


def _server_id(value: str) -> UUID:
    try:
        return UUID(str(value))
    except (ValueError, AttributeError, TypeError) as exc:
        raise ValueError("MCP server id 无效") from exc


async def _manage_mcp_servers(db, user_id, args: dict):
    from sqlalchemy import select

    from agent.mcp.manager import McpToolManager, mcp_manager
    from app.api.v1.mcp_settings import (
        _check_endpoint,
        _server_view,
        _validate_common,
        _validate_name,
    )
    from app.core.config import get_settings
    from app.models import UserMcpServer

    action = str(args.get("action") or "").strip()
    if action == "list":
        rows = (await db.execute(
            select(UserMcpServer).where(
                UserMcpServer.user_id == user_id,
                UserMcpServer.scope == "user",
            ).order_by(UserMcpServer.created_at)
        )).scalars().all()
        return {"items": [_server_view(row) for row in rows]}

    server = None
    if action not in {"list", "add"}:
        try:
            server_id = _server_id(str(args.get("server_id") or ""))
        except ValueError as exc:
            return {"error": str(exc)}
        server = await db.scalar(select(UserMcpServer).where(
            UserMcpServer.id == server_id,
            UserMcpServer.user_id == user_id,
            UserMcpServer.scope == "user",
        ))

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
        row = UserMcpServer(
            user_id=user_id, scope="user", name=name, transport=transport, endpoint=endpoint,
            command=command,
            enabled=bool(args.get("enabled", True)),
            confirm_mode=str(args.get("confirm_mode") or "confirm_all"),
            timeout_seconds=int(args.get("timeout_seconds") or settings.mcp.default_timeout_seconds),
            tool_allowlist=list(args.get("tool_allowlist") or []),
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        # 只返回字段定义，不返回可写入聊天记录的凭据入口。核心交互桥会把
        # 这些字段落成短时 Prompt，网页端再通过独立的安全接口提交值。
        return {
            "_interaction": "ask_user",
            "kind": "form",
            "title": f"补全 MCP 服务凭据：{name}",
            "body": "服务已添加。请在下方安全输入凭据；凭据不会写入聊天记录。",
            "options": [],
            "secret_fields": [
                {"name": "Authorization", "label": "Authorization", "type": "secret"},
            ],
            "credential_server_id": str(row.id),
            "allow_text_input": False,
        }

    if server is None:
        return {"error": "MCP server 不存在或不属于当前账号"}

    if action in {"enable", "disable"}:
        server.enabled = action == "enable"
        await db.flush()
        mcp_manager.invalidate_server(user_id, server.id)
        return {"success": True, "server": _server_view(server)}

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
        if config.transport == "stdio":
            from app.services.workspaces import resolve_sandbox_root
            from agent.mcp.stdio_client import McpStdioClient

            root = await resolve_sandbox_root(db, user_id)
            if root is None:
                return {"ok": False, "error": "当前存储后端没有可用的 stdio 沙盒"}
            client = McpStdioClient(
                config.command, root=str(root), timeout_seconds=float(config.timeout_seconds),
            )
        else:
            from agent.mcp.client import McpClient

            client = McpClient(
                config.endpoint, headers=config.headers,
                timeout_seconds=float(config.timeout_seconds),
            )
        try:
            listing = await client.list_tools()
            if "error" in listing:
                return {"ok": False, "error": listing["error"]}
            return {"ok": True, "tool_count": len(listing.get("tools") or []), "message": "连接成功。"}
        finally:
            close = getattr(client, "aclose", None)
            if close is not None:
                await close()

    return {"error": "action 只支持 list / add / enable / disable / remove / test_connection"}


class McpSkill(BaseSkill):
    name = "mcp-management"
    tools = [Tool(
        name="manage_mcp_servers",
        label="管理 MCP 服务",
        description_short="管理当前账号的 MCP server 配置",
        description=(
            "管理当前账号自己的 MCP server。支持 list、add、enable、disable、remove、test_connection。"
            "add 只保存名称、endpoint 和非敏感参数；不要在对话中索要或传递凭据，凭据须由安全输入组件补全。"
            "add 和 remove 会要求用户确认。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "add", "enable", "disable", "remove", "test_connection"]},
                "server_id": {"type": "string", "maxLength": 64},
                "name": {"type": "string", "maxLength": 64},
                "endpoint": {"type": "string", "maxLength": 1000},
                "transport": {"type": "string", "enum": ["http", "stdio"]},
                "command": {"type": "string", "maxLength": 1000},
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
        requires_confirmation=True,
    )]


McpSkill().register()
