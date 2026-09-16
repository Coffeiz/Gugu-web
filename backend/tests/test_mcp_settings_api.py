"""MCP1-004 验收：用户 MCP server 配置 CRUD、上限拒绝、凭据掩码、URL 校验、越权 404。

按仓库惯例直调路由函数（不起 TestClient）；URL 安全校验 monkeypatch 掉真实 DNS。
"""
from __future__ import annotations

import json
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import mcp_settings as api
from app.models import ConversationSession, InteractionPrompt, UserMcpServer


@pytest.fixture(autouse=True)
def _safe_url(monkeypatch):
    """单测不碰真实 DNS：endpoint 前置校验直接放行公网、拒绝内网样例由专门用例覆盖。"""
    monkeypatch.setattr(api, "url_is_safe", lambda url: None if "internal" not in url else "该地址指向内网/本机，出于安全考虑不予下载")


@pytest.fixture
def mcp_on(monkeypatch):
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.mcp, "enabled", True)


async def test_create_and_view_credential_slots(db, user_a):
    created = await api.create_server(
        api.McpServerCreate(name="weather", endpoint="https://mcp.example.com/rpc",
                            credential_slots=[{"id": "api_key", "label": "服务 Key", "target": "header", "name": "Authorization", "prefix": "Bearer "}]),
        user=user_a, db=db,
    )
    assert created["name"] == "weather"
    assert created["has_credentials"] is False
    assert created["credential_slots"][0]["id"] == "api_key"
    assert "Authorization" in json.dumps(created)

    # 配置接口只保存注入规则，不接收或落库敏感值。
    row = (await db.execute(select(UserMcpServer).where(UserMcpServer.name == "weather"))).scalar_one()
    assert row.credential_slots[0]["id"] == "api_key"
    assert not row.encrypted_credentials


async def test_name_conflict_and_invalid_names(db, user_a):
    await api.create_server(api.McpServerCreate(name="weather", endpoint="https://mcp.example.com"),
                            user=user_a, db=db)
    with pytest.raises(HTTPException) as exc:
        await api.create_server(api.McpServerCreate(name="weather", endpoint="https://mcp2.example.com"),
                                user=user_a, db=db)
    assert "已存在" in exc.value.detail
    created = await api.create_server(
        api.McpServerCreate(name="高德", endpoint="https://mcp.example.com/gaode"),
        user=user_a, db=db,
    )
    assert created["name"] == "高德"
    with pytest.raises(HTTPException):
        await api.create_server(api.McpServerCreate(name="我的 server!", endpoint="https://mcp.example.com"),
                                user=user_a, db=db)


async def test_url_validation_rejected(db, user_a):
    with pytest.raises(HTTPException) as exc:
        await api.create_server(
            api.McpServerCreate(name="intranet", endpoint="https://internal.server/rpc"),
            user=user_a, db=db,
        )
    assert "内网" in exc.value.detail


async def test_server_limit_rejected(db, user_a, monkeypatch):
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.mcp, "max_servers_per_user", 2)
    for i in range(2):
        await api.create_server(api.McpServerCreate(name=f"srv{i}", endpoint="https://m.example.com"),
                                user=user_a, db=db)
    with pytest.raises(HTTPException) as exc:
        await api.create_server(api.McpServerCreate(name="srv2", endpoint="https://m.example.com"),
                                user=user_a, db=db)
    assert "最多添加 2 个" in exc.value.detail


async def test_cross_user_access_is_404(db, user_a, user_b):
    created = await api.create_server(api.McpServerCreate(name="mine", endpoint="https://m.example.com"),
                                      user=user_a, db=db)
    mine_id = created["id"]
    with pytest.raises(HTTPException) as exc:
        await api.update_server(mine_id, api.McpServerPatch(enabled=False), user=user_b, db=db)
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        await api.delete_server(mine_id, user=user_b, db=db)
    assert exc.value.status_code == 404


async def test_update_invalidates_cache(db, user_a, monkeypatch):
    invalidated: list[str] = []
    from agent.mcp.manager import mcp_manager

    monkeypatch.setattr(mcp_manager, "invalidate_server",
                        lambda user_id, server_id: invalidated.append(str(server_id)))
    created = await api.create_server(api.McpServerCreate(name="cache", endpoint="https://m.example.com"),
                                      user=user_a, db=db)
    await api.update_server(created["id"], api.McpServerPatch(enabled=False), user=user_a, db=db)
    assert invalidated == [created["id"]]
    row = (await db.execute(select(UserMcpServer).where(UserMcpServer.name == "cache"))).scalar_one()
    assert row.enabled is False


async def test_delete_removes_row(db, user_a):
    created = await api.create_server(api.McpServerCreate(name="gone", endpoint="https://m.example.com"),
                                      user=user_a, db=db)
    result = await api.delete_server(created["id"], user=user_a, db=db)
    assert result["deleted"] is True
    left = (await db.execute(select(UserMcpServer))).scalars().all()
    assert left == []


async def test_invalid_common_fields_rejected(db, user_a):
    with pytest.raises(HTTPException):
        await api.create_server(api.McpServerCreate(name="ok", endpoint="https://m.example.com",
                                                    confirm_mode="sometimes"), user=user_a, db=db)
    with pytest.raises(HTTPException):
        await api.create_server(api.McpServerCreate(name="ok", endpoint="https://m.example.com",
                                                    timeout_seconds=9999), user=user_a, db=db)
    with pytest.raises(HTTPException):
        await api.create_server(api.McpServerCreate(name="ok", endpoint="https://m.example.com",
                                                    tool_allowlist=[f"t{i}" for i in range(65)]),
                                user=user_a, db=db)


async def test_credential_slots_update(db, user_a):
    created = await api.create_server(
        api.McpServerCreate(name="cred", endpoint="https://m.example.com"),
        user=user_a, db=db,
    )
    updated = await api.update_server(created["id"], api.McpServerPatch(credential_slots=[
        {"id": "key", "label": "Key", "target": "query", "name": "key"},
    ]), user=user_a, db=db)
    assert updated["credential_slots"][0]["id"] == "key"
    assert updated["has_credentials"] is False


async def test_http_patch_accepts_inactive_empty_command(db, user_a):
    """HTTP 表单带回空 command 时，应由 transport 校验而非长度校验拦截。"""
    created = await api.create_server(
        api.McpServerCreate(name="http_edit", endpoint="https://m.example.com"),
        user=user_a,
        db=db,
    )
    updated = await api.update_server(
        created["id"],
        api.McpServerPatch(endpoint="https://m2.example.com", command=""),
        user=user_a,
        db=db,
    )
    assert updated["endpoint"] == "https://m2.example.com"
    assert updated["command"] == ""


async def test_test_connection_reports_tools(db, user_a, monkeypatch):
    created = await api.create_server(api.McpServerCreate(name="echo", endpoint="https://m.example.com"),
                                      user=user_a, db=db)

    class FakeClient:
        def __init__(self, endpoint, headers=None, query_params=None, timeout_seconds=30.0):
            pass

        async def list_tools(self):
            return {"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}

    monkeypatch.setattr("agent.mcp.manager.McpClient", FakeClient)
    result = await api.test_connection(created["id"], user=user_a, db=db)
    assert result["ok"] is True
    assert result["tool_count"] == 1

    class DeadClient:
        def __init__(self, endpoint, headers=None, query_params=None, timeout_seconds=30.0):
            pass

        async def list_tools(self):
            return {"error": "无法连接 MCP server，请检查地址与网络", "error_kind": "network"}

    monkeypatch.setattr("agent.mcp.manager.McpClient", DeadClient)
    failed = await api.test_connection(created["id"], user=user_a, db=db)
    assert failed["ok"] is False
    assert "无法连接" in failed["error"]


async def test_test_connection_rejects_tools_over_limit(db, user_a, monkeypatch):
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.mcp, "max_tools_per_server", 1)
    created = await api.create_server(api.McpServerCreate(name="many", endpoint="https://m.example.com"),
                                      user=user_a, db=db)

    class TooManyClient:
        def __init__(self, endpoint, headers=None, query_params=None, timeout_seconds=30.0):
            pass

        async def list_tools(self):
            schema = {"type": "object", "properties": {}}
            return {"tools": [
                {"name": "one", "inputSchema": schema},
                {"name": "two", "inputSchema": schema},
            ]}

    monkeypatch.setattr("agent.mcp.manager.McpClient", TooManyClient)
    result = await api.test_connection(created["id"], user=user_a, db=db)
    assert result["ok"] is False
    assert result["tools"] == []
    assert "超出单个 server 上限" in result["error"]


async def test_manage_mcp_servers_can_resolve_actions_by_name(db, user_a):
    from agent.tools.mcp import _manage_mcp_servers

    created = await api.create_server(
        api.McpServerCreate(name="amap", endpoint="https://mcp.example.com/mcp"),
        user=user_a,
        db=db,
    )
    result = await _manage_mcp_servers(
        db,
        user_a.id,
        {"action": "enable", "name": created["name"]},
    )
    assert result["success"] is True
    assert result["server"]["id"] == created["id"]


async def test_manage_mcp_servers_can_update_non_secret_config(db, user_a):
    from agent.tools.mcp import _manage_mcp_servers

    created = await api.create_server(
        api.McpServerCreate(name="editable", endpoint="https://mcp.example.com/old"),
        user=user_a,
        db=db,
    )
    result = await _manage_mcp_servers(db, user_a.id, {
        "action": "update",
        "server_id": created["id"],
        "endpoint": "https://mcp.example.com/new",
        "timeout_seconds": 45,
        "enabled": False,
    })
    assert result["success"] is True
    assert result["server"]["endpoint"] == "https://mcp.example.com/new"
    assert result["server"]["timeout_seconds"] == 45
    assert result["server"]["enabled"] is False
    row = await db.scalar(select(UserMcpServer).where(UserMcpServer.id == UUID(created["id"])))
    assert row.encrypted_credentials == ""
    assert "_interaction" not in result


async def test_manage_mcp_servers_uses_generic_secret_prompt_for_slots(db, user_a, monkeypatch):
    from agent.tools.mcp import _manage_mcp_servers
    from app.services.interactions import create_agent_prompt
    from app.services.mcp_credentials import consume_mcp_secret_prompt
    from app.models import ConversationSession

    monkeypatch.setattr("agent.interactions.confirmations.needs_confirmation", lambda *args, **kwargs: None)
    result = await _manage_mcp_servers(db, user_a.id, {
        "action": "add",
        "name": "generic_auth",
        "endpoint": "https://m.example.com/mcp?key={{secret:key}}",
        "credential_slots": [
            {"id": "key", "label": "服务 Key", "target": "query", "name": "key"},
        ],
    })
    assert result["_interaction"] == "ask_user"
    assert result["secret_fields"] == [{"name": "key", "label": "服务 Key", "type": "secret"}]
    assert "secret_target" in result

    session = ConversationSession(user_id=user_a.id, title="通用敏感字段", source="web")
    db.add(session)
    await db.commit()
    prompt, _ = await create_agent_prompt(
        user_id=user_a.id, session_id=session.id, tool_call_id="generic-secret",
        tool_name="manage_mcp_servers", payload=result,
    )
    await db.commit()
    saved = await consume_mcp_secret_prompt(
        prompt, {"key": "hidden-key"}, user=user_a, db=db,
    )
    assert saved["ok"] is True
    row = await db.scalar(select(UserMcpServer).where(UserMcpServer.name == "generic_auth"))
    assert row.encrypted_credentials
    assert "hidden-key" not in row.encrypted_credentials


async def test_manage_mcp_servers_requires_server_id_or_name(db, user_a):
    from agent.tools.mcp import _manage_mcp_servers

    result = await _manage_mcp_servers(db, user_a.id, {"action": "test_connection"})
    assert result == {"error": "需要提供 server_id 或 name"}


async def test_credentials_prompt_is_sealed_and_resolves_without_echoing_value(db, user_a):
    from app.services.interactions import create_agent_prompt, list_history

    created = await api.create_server(
        api.McpServerCreate(
            name="secure", endpoint="https://m.example.com",
            credential_slots=[{"id": "Authorization", "label": "Authorization", "target": "header", "name": "Authorization"}],
        ),
        user=user_a, db=db,
    )
    session = ConversationSession(user_id=user_a.id, title="MCP 凭据测试", source="web")
    db.add(session)
    await db.commit()
    prompt, actions = await create_agent_prompt(
        user_id=user_a.id, session_id=session.id, tool_call_id="call-credentials",
        tool_name="manage_mcp_servers",
        payload={
            "_interaction": "ask_user", "kind": "form", "title": "补全凭据",
            "body": "请输入凭据", "options": [],
            "secret_fields": [{"name": "Authorization", "label": "Authorization", "type": "secret"}],
            "secret_target": {"kind": "mcp_credentials", "server_id": created["id"]},
        },
    )
    await db.commit()
    assert actions == []
    assert prompt.schema_json["secret_fields"] == [
        {"name": "Authorization", "label": "Authorization", "type": "secret"},
    ]

    from app.services.mcp_credentials import consume_mcp_secret_prompt
    result = await consume_mcp_secret_prompt(
        prompt, {"Authorization": "Bearer hidden-secret"}, user=user_a, db=db,
    )
    assert result == {"ok": True, "prompt_id": prompt.id}
    stored = await db.get(InteractionPrompt, prompt.id)
    assert stored.status == "resolved"
    assert "hidden-secret" not in json.dumps(stored.schema_json)
    history = await list_history(db, user_id=user_a.id, session_id=session.id)
    assert history[0]["secret_fields"][0]["name"] == "Authorization"
    assert "hidden-secret" not in json.dumps(history)


async def test_endpoint_credentials_are_encrypted_and_masked(db, user_a):
    created = await api.create_server(
        api.McpServerCreate(
            name="amap_endpoint",
            endpoint="https://mcp.amap.com/mcp?key=secret-amap-key",
        ),
        user=user_a,
        db=db,
    )
    assert created["endpoint"] == "https://mcp.amap.com/mcp?key=secret-amap-key"
    row = await db.scalar(select(UserMcpServer).where(UserMcpServer.id == UUID(created["id"])))
    assert row.encrypted_endpoint
    assert "secret-amap-key" not in row.encrypted_endpoint
    from app.byok.crypto import decrypt_envelope
    assert decrypt_envelope(
        row.encrypted_endpoint, row.endpoint_nonce, row.encrypted_endpoint_key,
        key_version=row.endpoint_key_version,
    ) == "https://mcp.amap.com/mcp?key=secret-amap-key"


def test_manage_mcp_servers_mutation_metadata_distinguishes_read_actions():
    """管理工具的只读动作不能继承整个复合工具的 mutates 标记。"""
    from agent.tools.mcp import McpSkill

    tool = next(item for item in McpSkill.tools if item.name == "manage_mcp_servers")
    assert tool.mutates is True
    assert tool.mutates_for_input({"action": "list"}) is False
    assert tool.mutates_for_input({"action": "test_connection"}) is False
    assert tool.mutates_for_input({"action": "add"}) is True
    assert tool.mutates_for_input({"action": "update"}) is True
    assert tool.observes_for_input({"action": "list"}) is True
    assert tool.observes_for_input({"action": "test_connection"}) is True
    assert tool.observes_for_input({"action": "add"}) is False


def test_manage_mcp_servers_schema_accepts_credential_slots():
    from agent.tools.mcp import McpSkill

    tool = next(item for item in McpSkill.tools if item.name == "manage_mcp_servers")
    slots = tool.input_schema["properties"]["credential_slots"]
    assert slots["type"] == "array"
    assert slots["items"]["properties"]["target"]["enum"] == ["header", "query"]
