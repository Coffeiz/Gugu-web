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
    kebab_name = await api.create_server(
        api.McpServerCreate(name="mock-mcp", endpoint="https://mcp.example.com/kebab"),
        user=user_a, db=db,
    )
    assert kebab_name["name"] == "mock-mcp"
    with pytest.raises(HTTPException):
        await api.create_server(api.McpServerCreate(name="我的 server!", endpoint="https://mcp.example.com"),
                                user=user_a, db=db)


async def test_url_validation_rejected(db, user_a):
    with pytest.raises(HTTPException) as exc:
        await api.create_server(
            api.McpServerCreate(name="intranet", endpoint="http://127.0.0.1/rpc"),
            user=user_a, db=db,
        )
    assert "内网" in exc.value.detail


async def test_save_endpoint_does_not_require_dns_resolution(db, user_a):
    """保存可解析性暂不可用的域名不发外网请求；实际连接仍由 pinned resolver 校验。"""
    created = await api.create_server(
        api.McpServerCreate(name="dns_pending", endpoint="https://mcp.unresolvable.invalid/mcp"),
        user=user_a, db=db,
    )
    assert created["endpoint"] == "https://mcp.unresolvable.invalid/mcp"


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


async def test_list_servers_does_not_connect_and_returns_existing_runtime_state(
    db, user_a, monkeypatch,
):
    from agent.mcp.manager import mcp_manager

    unloaded = await api.create_server(
        api.McpServerCreate(name="not_loaded", endpoint="https://m.example.com/one"),
        user=user_a, db=db,
    )
    loaded = await api.create_server(
        api.McpServerCreate(name="already_loaded", endpoint="https://m.example.com/two"),
        user=user_a, db=db,
    )

    async def unexpected_connection(_user_id):
        raise AssertionError("GET /mcp/servers 不应连接 MCP server")

    monkeypatch.setattr(mcp_manager, "list_user_tools", unexpected_connection)
    monkeypatch.setattr(mcp_manager, "server_states", lambda _user_id: [{
        "server_id": loaded["id"],
        "state": "ok",
        "tool_count": 2,
        "tool_names": ["mcp_already_loaded_one", "mcp_already_loaded_two"],
    }])

    result = await api.list_servers(user=user_a, db=db)
    items = {item["id"]: item for item in result["items"]}

    assert items[unloaded["id"]]["state"] == "unloaded"
    assert items[unloaded["id"]]["loaded_tool_count"] == 0
    assert items[loaded["id"]]["state"] == "ok"
    assert items[loaded["id"]]["loaded_tool_count"] == 2
    assert items[loaded["id"]]["loaded_tool_names"] == [
        "mcp_already_loaded_one", "mcp_already_loaded_two",
    ]


async def test_load_server_status_checks_only_requested_owned_enabled_server(
    db, user_a, monkeypatch, mcp_on,
):
    from agent.mcp.manager import mcp_manager

    created = await api.create_server(
        api.McpServerCreate(name="status_check", endpoint="https://m.example.com"),
        user=user_a,
        db=db,
    )
    calls = []

    async def ensure_status(config):
        calls.append(config.id)
        return {
            "ok": True,
            "state": "ok",
            "tool_count": 2,
            "tool_names": ["status_check_first", "status_check_second"],
            "error": None,
        }

    monkeypatch.setattr(mcp_manager, "ensure_server_status", ensure_status)
    result = await api.load_server_status(created["id"], user=user_a, db=db)

    assert result["ok"] is True
    assert result["tool_count"] == 2
    assert calls == [UUID(created["id"])]


async def test_load_server_status_does_not_connect_disabled_server(db, user_a, monkeypatch):
    from agent.mcp.manager import mcp_manager

    created = await api.create_server(
        api.McpServerCreate(
            name="disabled_status_check",
            endpoint="https://m.example.com",
            enabled=False,
        ),
        user=user_a,
        db=db,
    )

    async def unexpected_connection(_config):
        raise AssertionError("停用的 MCP server 不应建立连接")

    monkeypatch.setattr(mcp_manager, "ensure_server_status", unexpected_connection)
    result = await api.load_server_status(created["id"], user=user_a, db=db)

    assert result["state"] == "disabled"
    assert result["tool_count"] == 0


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


async def test_credentials_prompt_is_sealed_and_resolves_for_web_group_session(db, user_a, user_b):
    from app.services.interactions import create_agent_prompt, list_history

    created = await api.create_server(
        api.McpServerCreate(
            name="secure", endpoint="https://m.example.com",
            credential_slots=[{"id": "Authorization", "label": "Authorization", "target": "header", "name": "Authorization"}],
        ),
        user=user_a, db=db,
    )
    session = ConversationSession(
        user_id=user_a.id, title="MCP 凭据测试", source="qq", bot_id="bot-a",
        chat_type="group", chat_id="group-a", platform_user_id="member-a",
    )
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
    with pytest.raises(HTTPException) as denied:
        await consume_mcp_secret_prompt(
            prompt, {"Authorization": "Bearer hidden-secret"}, user=user_b, db=db,
        )
    assert denied.value.status_code == 404
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


async def test_im_secret_staging_is_scope_bound_encrypted_and_commits_atomically(db, user_a):
    from app.byok.crypto import decrypt_envelope
    from app.models import McpSecretInput
    from app.services.interactions import create_agent_prompt
    from app.services.mcp_secret_inputs import (
        McpSecretBinding,
        consume_mcp_secret_field,
        start_mcp_secret_input,
    )

    server = UserMcpServer(
        user_id=user_a.id, scope="user", name="private_input",
        endpoint="https://m.example.com/mcp", credential_slots=[
            {"id": "client_id", "label": "Client ID", "target": "header", "name": "X-Client"},
            {"id": "client_secret", "label": "Client Secret", "target": "header", "name": "X-Secret"},
        ],
    )
    session = ConversationSession(
        user_id=user_a.id, title="private input", source="qq", bot_id="bot-a",
        platform_user_id="owner-a", chat_type="c2c",
    )
    db.add_all([server, session])
    await db.commit()
    prompt, _ = await create_agent_prompt(
        user_id=user_a.id, session_id=session.id, tool_call_id="call-private-input",
        tool_name="manage_mcp_servers", payload={
            "_interaction": "ask_user", "kind": "form", "title": "补全凭据",
            "secret_fields": [
                {"name": "client_id", "label": "Client ID", "type": "secret"},
                {"name": "client_secret", "label": "Client Secret", "type": "secret"},
            ],
            "secret_target": {"kind": "mcp_credentials", "server_id": str(server.id)},
        },
    )
    stage = await db.scalar(select(McpSecretInput).where(McpSecretInput.prompt_id == prompt.id))
    assert stage is not None and stage.status == "pending_choice"
    assert stage.platform == "qq" and stage.bot_id == "bot-a"

    binding = McpSecretBinding(
        prompt_id=prompt.id, user_id=user_a.id, platform="qq", bot_id="bot-a",
        chat_type="c2c", chat_id=None, platform_user_id="owner-a",
    )
    started = await start_mcp_secret_input(db, binding=binding, event_id="event-choice")
    assert started["status"] == "awaiting_secret"

    field = await consume_mcp_secret_field(
        db, binding=binding,
        event_id="event-field-1", value="sample-client-id",
    )
    assert field["status"] == "awaiting_secret"
    stage = await db.scalar(select(McpSecretInput).where(McpSecretInput.prompt_id == prompt.id))
    assert stage.encrypted_payload and "sample-client-id" not in stage.encrypted_payload
    assert "sample-client-id" not in json.dumps(prompt.schema_json)

    saved = await consume_mcp_secret_field(
        db, binding=binding,
        event_id="event-field-2", value="sample-client-secret",
    )
    assert saved["status"] == "completed"
    await db.commit()
    await db.refresh(server)
    prompt = await db.get(InteractionPrompt, prompt.id)
    await db.refresh(stage)
    assert json.loads(decrypt_envelope(
        server.encrypted_credentials, server.credentials_nonce,
        server.encrypted_credentials_key, key_version=server.credentials_key_version,
    )) == {"client_id": "sample-client-id", "client_secret": "sample-client-secret"}
    assert stage.status == "completed" and stage.encrypted_payload == ""
    assert prompt.status == "resolved"
    assert "sample-client-secret" not in json.dumps(prompt.schema_json)


async def test_im_secret_staging_refuses_group_and_cross_bot_scope(db, user_a):
    from app.models import McpSecretInput
    from app.services.interactions import create_agent_prompt
    from app.services.mcp_secret_inputs import McpSecretBinding, start_mcp_secret_input

    server = UserMcpServer(
        user_id=user_a.id, scope="user", name="group_input", endpoint="https://m.example.com",
        credential_slots=[{"id": "key", "label": "Key", "target": "header", "name": "X-Key"}],
    )
    group_session = ConversationSession(
        user_id=user_a.id, title="group", source="qq", bot_id="bot-a",
        chat_id="group-a", platform_user_id="member-a", chat_type="group",
    )
    private_session = ConversationSession(
        user_id=user_a.id, title="private", source="qq", bot_id="bot-a",
        platform_user_id="owner-a", chat_type="c2c",
    )
    db.add_all([server, group_session, private_session])
    await db.commit()
    payload = {
        "_interaction": "ask_user", "kind": "form", "title": "补全凭据",
        "secret_fields": [{"name": "key", "label": "Key", "type": "secret"}],
        "secret_target": {"kind": "mcp_credentials", "server_id": str(server.id)},
    }
    group_prompt, _ = await create_agent_prompt(
        user_id=user_a.id, session_id=group_session.id, tool_call_id="call-group",
        tool_name="manage_mcp_servers", payload=payload,
    )
    private_prompt, _ = await create_agent_prompt(
        user_id=user_a.id, session_id=private_session.id, tool_call_id="call-private",
        tool_name="manage_mcp_servers", payload=payload,
    )
    assert await db.scalar(select(McpSecretInput).where(
        McpSecretInput.prompt_id == group_prompt.id,
    )) is None

    with pytest.raises(HTTPException) as error:
        await start_mcp_secret_input(
            db,
            binding=McpSecretBinding(
                prompt_id=private_prompt.id, user_id=user_a.id, platform="qq",
                bot_id="different-bot", chat_type="c2c", chat_id=None,
                platform_user_id="owner-a",
            ),
            event_id="event-wrong-bot",
        )
    assert error.value.status_code == 404

    from sqlalchemy import update
    mismatched_schema = {
        **private_prompt.schema_json,
        "context": {
            **private_prompt.schema_json["context"],
            "secret_target": {
                **private_prompt.schema_json["context"]["secret_target"],
                "server_id": str(UUID(int=0)),
            },
        },
    }
    await db.execute(update(InteractionPrompt).where(
        InteractionPrompt.id == private_prompt.id,
    ).values(schema_json=mismatched_schema))
    await db.commit()
    with pytest.raises(HTTPException) as server_error:
        await start_mcp_secret_input(
            db,
            binding=McpSecretBinding(
                prompt_id=private_prompt.id, user_id=user_a.id, platform="qq",
                bot_id="bot-a", chat_type="c2c", chat_id=None, platform_user_id="owner-a",
            ),
            event_id="event-wrong-server",
        )
    assert server_error.value.status_code == 404


async def test_secret_validation_rejects_oversize_and_extra_fields_without_replacing_credentials(db, user_a):
    from app.services.interactions import create_agent_prompt
    from app.services.mcp_credentials import consume_mcp_secret_prompt
    from app.services.mcp_secret_inputs import McpSecretBinding, consume_mcp_secret_field, start_mcp_secret_input

    server = UserMcpServer(
        user_id=user_a.id, scope="user", name="validation_secret", endpoint="https://m.example.com",
        credential_slots=[{"id": "key", "label": "Key", "target": "header", "name": "X-Key"}],
        encrypted_credentials="existing-ciphertext",
    )
    session = ConversationSession(
        user_id=user_a.id, title="validation", source="qq", bot_id="bot-a",
        platform_user_id="owner-a", chat_type="c2c",
    )
    db.add_all([server, session])
    await db.commit()
    payload = {
        "_interaction": "ask_user", "kind": "form", "title": "补全凭据",
        "secret_fields": [{"name": "key", "label": "Key", "type": "secret"}],
        "secret_target": {"kind": "mcp_credentials", "server_id": str(server.id)},
    }
    prompt, _ = await create_agent_prompt(
        user_id=user_a.id, session_id=session.id, tool_call_id="oversize-secret",
        tool_name="manage_mcp_servers", payload=payload,
    )
    binding = McpSecretBinding(
        prompt_id=prompt.id, user_id=user_a.id, platform="qq", bot_id="bot-a",
        chat_type="c2c", chat_id=None, platform_user_id="owner-a",
    )
    await start_mcp_secret_input(db, binding=binding, event_id="oversize-start")
    result = await consume_mcp_secret_field(
        db, binding=binding, event_id="oversize-field", value="x" * 4097,
    )
    assert result["status"] == "failed"
    await db.commit()
    await db.refresh(server)
    assert server.encrypted_credentials == "existing-ciphertext"

    web_prompt, _ = await create_agent_prompt(
        user_id=user_a.id, session_id=session.id, tool_call_id="extra-secret-field",
        tool_name="manage_mcp_servers", payload=payload,
    )
    with pytest.raises(HTTPException) as error:
        await consume_mcp_secret_prompt(
            web_prompt, {"key": "new-value", "unexpected": "extra-value"}, user=user_a, db=db,
        )
    assert error.value.status_code == 400
    await db.refresh(server)
    assert server.encrypted_credentials == "existing-ciphertext"
    assert web_prompt.status == "active"


async def test_im_secret_cancel_is_idempotent_and_expiry_cleanup_removes_staging(db, user_a):
    from datetime import timedelta
    from app.core.tz import now_utc
    from app.models import McpSecretInput
    from app.services.interactions import create_agent_prompt
    from app.services.mcp_secret_inputs import (
        McpSecretBinding,
        cancel_mcp_secret_input,
        cleanup_expired_mcp_secret_inputs,
        start_mcp_secret_input,
    )

    server = UserMcpServer(
        user_id=user_a.id, scope="user", name="cancel_input", endpoint="https://m.example.com",
        credential_slots=[{"id": "key", "label": "Key", "target": "header", "name": "X-Key"}],
        encrypted_credentials="existing-ciphertext",
    )
    session = ConversationSession(
        user_id=user_a.id, title="cancel", source="qq", bot_id="bot-a",
        platform_user_id="owner-a", chat_type="c2c",
    )
    db.add_all([server, session])
    await db.commit()
    prompt, _ = await create_agent_prompt(
        user_id=user_a.id, session_id=session.id, tool_call_id="call-cancel",
        tool_name="manage_mcp_servers", payload={
            "_interaction": "ask_user", "kind": "form", "title": "补全凭据",
            "secret_fields": [{"name": "key", "label": "Key", "type": "secret"}],
            "secret_target": {"kind": "mcp_credentials", "server_id": str(server.id)},
        },
    )
    binding = McpSecretBinding(
        prompt_id=prompt.id, user_id=user_a.id, platform="qq", bot_id="bot-a",
        chat_type="c2c", chat_id=None, platform_user_id="owner-a",
    )
    await start_mcp_secret_input(db, binding=binding, event_id="cancel-start")
    cancelled = await cancel_mcp_secret_input(db, binding=binding, event_id="cancel-event")
    duplicate = await cancel_mcp_secret_input(db, binding=binding, event_id="cancel-event")
    assert cancelled["status"] == "cancelled"
    assert duplicate["status"] in {"cancelled", "duplicate"}
    await db.commit()
    stage = await db.scalar(select(McpSecretInput).where(McpSecretInput.prompt_id == prompt.id))
    await db.refresh(server)
    assert stage.encrypted_payload == "" and stage.status == "cancelled"
    assert server.encrypted_credentials == "existing-ciphertext"

    expiry_session = ConversationSession(
        user_id=user_a.id, title="expiry", source="qq", bot_id="bot-a",
        platform_user_id="owner-a", chat_type="c2c",
    )
    db.add(expiry_session)
    await db.commit()
    expired_prompt, _ = await create_agent_prompt(
        user_id=user_a.id, session_id=expiry_session.id, tool_call_id="call-expiry",
        tool_name="manage_mcp_servers", payload={
            "_interaction": "ask_user", "kind": "form", "title": "补全凭据",
            "secret_fields": [{"name": "key", "label": "Key", "type": "secret"}],
            "secret_target": {"kind": "mcp_credentials", "server_id": str(server.id)},
        },
    )
    expiry_stage = await db.scalar(select(McpSecretInput).where(
        McpSecretInput.prompt_id == expired_prompt.id,
    ))
    expiry_stage.expires_at = now_utc() - timedelta(seconds=1)
    await db.commit()
    assert await cleanup_expired_mcp_secret_inputs(db) == 1
    assert await db.get(InteractionPrompt, expired_prompt.id) is None or (
        (await db.get(InteractionPrompt, expired_prompt.id)).status == "expired"
    )
    assert await db.scalar(select(McpSecretInput).where(
        McpSecretInput.prompt_id == expired_prompt.id,
    )) is None


async def test_im_secret_input_is_intercepted_before_history_and_group_scope_is_refused(db, user_a, monkeypatch):
    from app.models import ConversationMessage, McpSecretInput
    from app.services.interactions import create_agent_prompt, list_history
    from app.services.mcp_secret_inputs import McpSecretBinding, start_mcp_secret_input
    from agent.im.interaction_text import consume_mcp_secret_payload
    import agent.im.replies as replies

    server = UserMcpServer(
        user_id=user_a.id, scope="user", name="preflight_secret",
        endpoint="https://m.example.com/mcp", credential_slots=[
            {"id": "key", "label": "Access key", "target": "header", "name": "X-Key"},
        ],
    )
    private_session = ConversationSession(
        user_id=user_a.id, title="private", source="qq", bot_id="bot-a",
        platform_user_id="owner-a", chat_type="c2c",
    )
    group_session = ConversationSession(
        user_id=user_a.id, title="group", source="qq", bot_id="bot-a",
        chat_id="group-a", platform_user_id="member-a", chat_type="group",
    )
    db.add_all([server, private_session, group_session])
    await db.commit()
    secret_payload = {
        "_interaction": "ask_user", "kind": "form", "title": "补全凭据",
        "secret_fields": [{"name": "key", "label": "Access key", "type": "secret"}],
        "secret_target": {"kind": "mcp_credentials", "server_id": str(server.id)},
    }
    private_prompt, _ = await create_agent_prompt(
        user_id=user_a.id, session_id=private_session.id, tool_call_id="private-secret",
        tool_name="manage_mcp_servers", payload=secret_payload,
    )
    group_prompt, group_actions = await create_agent_prompt(
        user_id=user_a.id, session_id=group_session.id, tool_call_id="group-secret",
        tool_name="manage_mcp_servers", payload=secret_payload,
    )
    await db.commit()
    assert group_actions == []
    assert await db.scalar(select(McpSecretInput).where(McpSecretInput.prompt_id == group_prompt.id)) is None

    binding = McpSecretBinding(
        prompt_id=private_prompt.id, user_id=user_a.id, platform="qq", bot_id="bot-a",
        chat_type="c2c", chat_id=None, platform_user_id="owner-a",
    )
    await start_mcp_secret_input(db, binding=binding, event_id="start-private")
    await db.commit()
    sent: list[str] = []

    async def capture_reply(_payload, text):
        sent.append(text)
        return True

    monkeypatch.setattr(replies, "send_text", capture_reply)
    assert await consume_mcp_secret_payload({
        "platform": "qq", "channel_id": "bot-a", "owner_user_id": str(user_a.id),
        "platform_user_id": "owner-a", "chat_type": "c2c", "message_id": "secret-event",
        "text": "private-value-123", "attachments": [],
    }) is True
    private_prompt = await db.get(InteractionPrompt, private_prompt.id)
    stage = await db.scalar(select(McpSecretInput).where(McpSecretInput.prompt_id == private_prompt.id))
    messages = (await db.scalars(select(ConversationMessage))).all()
    assert private_prompt.status == "resolved"
    assert stage.status == "completed" and stage.encrypted_payload == ""
    assert messages == []
    assert "private-value-123" not in "".join(sent)
    assert "private-value-123" not in json.dumps(await list_history(
        db, user_id=user_a.id, session_id=private_session.id,
    ))
    reply_count = len(sent)
    assert await consume_mcp_secret_payload({
        "platform": "qq", "channel_id": "bot-a", "owner_user_id": str(user_a.id),
        "platform_user_id": "owner-a", "chat_type": "c2c", "message_id": "secret-event",
        "text": "private-value-123", "attachments": [],
    }) is True
    assert len(sent) == reply_count
    assert (await db.scalars(select(ConversationMessage))).all() == []

    next_prompt, _ = await create_agent_prompt(
        user_id=user_a.id, session_id=private_session.id, tool_call_id="next-secret",
        tool_name="manage_mcp_servers", payload=secret_payload,
    )
    await db.commit()
    assert await consume_mcp_secret_payload({
        "platform": "qq", "channel_id": "bot-a", "owner_user_id": str(user_a.id),
        "platform_user_id": "owner-a", "chat_type": "c2c", "message_id": "secret-event",
        "text": "private-value-123", "attachments": [],
    }) is True
    next_stage = await db.scalar(select(McpSecretInput).where(McpSecretInput.prompt_id == next_prompt.id))
    assert next_stage.status == "pending_choice"

    assert await consume_mcp_secret_payload({
        "platform": "qq", "channel_id": "bot-a", "owner_user_id": str(user_a.id),
        "chat_type": "group", "chat_id": "group-a",
        "message_id": "group-event", "text": "maybe-secret", "attachments": [],
    }) is True
    assert "群聊不接收 MCP 凭据" in sent[-1]


async def test_im_secret_callback_is_bound_to_private_actor_and_web_can_cancel_group_prompt(db, user_a):
    from app.services.interactions import create_agent_prompt, list_history
    from app.services.mcp_secret_inputs import consume_mcp_secret_action, cancel_mcp_secret_prompt_web

    server = UserMcpServer(
        user_id=user_a.id, scope="user", name="callback_secret", endpoint="https://m.example.com",
        credential_slots=[{"id": "key", "label": "Key", "target": "header", "name": "X-Key"}],
    )
    private_session = ConversationSession(
        user_id=user_a.id, title="private", source="feishu", bot_id="bot-feishu",
        platform_user_id="owner-open-id", chat_type="c2c",
    )
    group_session = ConversationSession(
        user_id=user_a.id, title="group", source="feishu", bot_id="bot-feishu",
        chat_id="group-open-id", platform_user_id="member-open-id", chat_type="group",
    )
    db.add_all([server, private_session, group_session])
    await db.commit()
    secret_payload = {
        "_interaction": "ask_user", "kind": "form", "title": "补全凭据",
        "secret_fields": [{"name": "key", "label": "Key", "type": "secret"}],
        "secret_target": {"kind": "mcp_credentials", "server_id": str(server.id)},
    }
    private_prompt, actions = await create_agent_prompt(
        user_id=user_a.id, session_id=private_session.id, tool_call_id="private-callback",
        tool_name="manage_mcp_servers", payload=secret_payload,
    )
    group_prompt, group_actions = await create_agent_prompt(
        user_id=user_a.id, session_id=group_session.id, tool_call_id="group-web-cancel",
        tool_name="manage_mcp_servers", payload=secret_payload,
    )
    await db.commit()
    assert [item["id"] for item in actions] == ["input_credentials", "cancel"]
    assert group_actions == []
    invalid_scopes = [
        {"platform": "qq", "bot_id": "bot-feishu", "platform_user_id": "owner-open-id", "chat_type": "c2c", "chat_id": None},
        {"platform": "feishu", "bot_id": "other-bot", "platform_user_id": "owner-open-id", "chat_type": "c2c", "chat_id": None},
        {"platform": "feishu", "bot_id": "bot-feishu", "platform_user_id": "other-open-id", "chat_type": "c2c", "chat_id": None},
        {"platform": "feishu", "bot_id": "bot-feishu", "platform_user_id": "owner-open-id", "chat_type": "group", "chat_id": "group-open-id"},
    ]
    for index, scope in enumerate(invalid_scopes):
        with pytest.raises(HTTPException) as error:
            await consume_mcp_secret_action(
                db, user_id=user_a.id, prompt_id=private_prompt.id, token=actions[0]["token"],
                event_id=f"wrong-scope-{index}", **scope,
            )
        assert error.value.status_code == 404
    with pytest.raises(HTTPException) as cross_prompt:
        await consume_mcp_secret_action(
            db, user_id=user_a.id, prompt_id=group_prompt.id, token=actions[0]["token"],
            event_id="cross-prompt", platform="feishu", bot_id="bot-feishu",
            platform_user_id="owner-open-id", chat_type="c2c", chat_id=None,
        )
    assert cross_prompt.value.status_code == 409

    started = await consume_mcp_secret_action(
        db, user_id=user_a.id, prompt_id=private_prompt.id, token=actions[0]["token"],
        event_id="right-actor", platform="feishu", bot_id="bot-feishu",
        platform_user_id="owner-open-id", chat_type="c2c", chat_id=None,
    )
    assert started["status"] == "awaiting_secret"
    duplicate = await consume_mcp_secret_action(
        db, user_id=user_a.id, prompt_id=private_prompt.id, token=actions[0]["token"],
        event_id="right-actor", platform="feishu", bot_id="bot-feishu",
        platform_user_id="owner-open-id", chat_type="c2c", chat_id=None,
    )
    assert duplicate["status"] == "duplicate"
    with pytest.raises(HTTPException) as replay:
        await consume_mcp_secret_action(
            db, user_id=user_a.id, prompt_id=private_prompt.id, token=actions[0]["token"],
            event_id="different-replay", platform="feishu", bot_id="bot-feishu",
            platform_user_id="owner-open-id", chat_type="c2c", chat_id=None,
        )
    assert replay.value.status_code == 409
    group_history = await list_history(db, user_id=user_a.id, session_id=group_session.id)
    assert group_history[0]["secret_fields"][0]["name"] == "key"
    assert group_history[0]["options"] == []
    cancelled = await cancel_mcp_secret_prompt_web(db, prompt=group_prompt, user_id=user_a.id)
    await db.commit()
    assert cancelled["status"] == "cancelled"
    assert (await db.get(InteractionPrompt, group_prompt.id)).status == "resolved"


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


async def test_credential_values_echo_and_roundtrip(db, user_a):
    """凭据槽位值在编辑视图明文回显（owner-only），落库仍为信封密文（产品定稿）。"""
    created = await api.create_server(
        api.McpServerCreate(
            name="sealed_source",
            endpoint="https://m.example.com",
            credential_slots=[{"id": "authorization", "label": "Authorization",
                               "target": "header", "name": "Authorization"}],
            credential_values={"authorization": "Bearer sk-live-123"},
        ),
        user=user_a,
        db=db,
    )
    # 回显明文
    assert created["credential_values"] == {"authorization": "Bearer sk-live-123"}
    # 落库为密文，无明文
    row = await db.scalar(select(UserMcpServer).where(UserMcpServer.id == UUID(created["id"])))
    assert "sk-live-123" not in row.encrypted_credentials
    assert row.encrypted_credentials

    # 更新值：回显与存储同步变化；缺省槽位 = 清除
    updated = await api.update_server(
        created["id"],
        api.McpServerPatch(credential_values={"authorization": "Bearer sk-new"}),
        user=user_a, db=db,
    )
    assert updated["credential_values"] == {"authorization": "Bearer sk-new"}

    # 不带 credential_values 的更新保留原值（如只改名称）
    renamed = await api.update_server(
        created["id"], api.McpServerPatch(name="sealed_renamed"), user=user_a, db=db,
    )
    assert renamed["credential_values"] == {"authorization": "Bearer sk-new"}

    # 值必须命中已声明的槽位
    with pytest.raises(HTTPException) as exc:
        await api.update_server(
            created["id"], api.McpServerPatch(credential_values={"ghost": "x"}),
            user=user_a, db=db,
        )
    assert "未知槽位" in exc.value.detail


async def test_non_ascii_header_credential_is_rejected_before_storage(db, user_a):
    created = await api.create_server(
        api.McpServerCreate(
            name="ascii_header",
            endpoint="https://m.example.com/mcp",
            credential_slots=[{
                "id": "api_key", "label": "API Key", "target": "header",
                "name": "Authorization", "prefix": "Bearer ",
            }],
        ),
        user=user_a, db=db,
    )
    with pytest.raises(HTTPException) as exc:
        await api.update_server(
            created["id"], api.McpServerPatch(credential_values={"api_key": "测试凭据"}),
            user=user_a, db=db,
        )
    assert "ASCII" in exc.value.detail
    row = await db.scalar(select(UserMcpServer).where(UserMcpServer.id == UUID(created["id"])))
    assert not row.encrypted_credentials


async def test_secret_prompt_can_retry_after_invalid_header_credential(db, user_a):
    from app.models import ConversationSession
    from app.services.interactions import create_agent_prompt
    from app.services.mcp_credentials import consume_mcp_secret_prompt

    created = await api.create_server(
        api.McpServerCreate(
            name="prompt_header",
            endpoint="https://m.example.com/mcp",
            credential_slots=[{
                "id": "api_key", "label": "API Key", "target": "header",
                "name": "Authorization", "prefix": "Bearer ",
            }],
        ),
        user=user_a, db=db,
    )
    session = ConversationSession(user_id=user_a.id, title="MCP 凭据", source="web")
    db.add(session)
    await db.commit()
    prompt, _ = await create_agent_prompt(
        user_id=user_a.id, session_id=session.id, tool_call_id="invalid-header-retry",
        tool_name="manage_mcp_servers", payload={
            "_interaction": "ask_user",
            "kind": "form",
            "title": "补全凭据",
            "secret_fields": [{"name": "api_key", "label": "API Key", "type": "secret"}],
            "secret_target": {"kind": "mcp_credentials", "server_id": created["id"]},
        },
    )
    await db.commit()

    with pytest.raises(HTTPException) as exc:
        await consume_mcp_secret_prompt(
            prompt, {"api_key": "测试凭据"}, user=user_a, db=db,
        )
    assert exc.value.status_code == 400
    assert "测试凭据" not in exc.value.detail
    assert prompt.status == "active"

    saved = await consume_mcp_secret_prompt(
        prompt, {"api_key": "valid-test-key"}, user=user_a, db=db,
    )
    assert saved["ok"] is True
    stored_prompt = await db.scalar(
        select(InteractionPrompt).where(InteractionPrompt.id == prompt.id)
    )
    assert stored_prompt.status == "resolved"
    row = await db.scalar(select(UserMcpServer).where(UserMcpServer.id == UUID(created["id"])))
    assert row.encrypted_credentials


async def test_legacy_headers_surface_in_edit_view_and_migrate_on_save(db, user_a):
    """legacy headers/query 密文行在编辑视图转换为槽位并明文回显；保存后迁移到槽位列。"""
    from app.byok.crypto import encrypt_envelope

    row = UserMcpServer(
        user_id=user_a.id, scope="user", name="legacy_github",
        transport="http", endpoint="https://api.example.com/mcp/",
        credential_slots=[],
    )
    ct, nonce, wrapped = encrypt_envelope(
        json.dumps({"Authorization": "Bearer ghp_legacy"}), allow_empty=False,
    )
    row.encrypted_headers, row.headers_nonce = ct, nonce
    row.encrypted_headers_key, row.headers_key_version = wrapped, 1
    db.add(row)
    await db.commit()
    await db.refresh(row)

    items = (await api.list_servers(user=user_a, db=db))["items"]
    legacy_view = next(i for i in items if i["name"] == "legacy_github")
    assert legacy_view["credential_slots"] == [{
        "id": "legacy_header_0", "label": "Authorization",
        "target": "header", "name": "Authorization", "prefix": "",
    }]
    assert legacy_view["credential_values"] == {"legacy_header_0": "Bearer ghp_legacy"}

    # 保存后迁移到新槽位列，legacy 密文清除
    await api.update_server(
        str(row.id),
        api.McpServerPatch(
            credential_slots=legacy_view["credential_slots"],
            credential_values=legacy_view["credential_values"],
        ),
        user=user_a, db=db,
    )
    migrated = await db.scalar(select(UserMcpServer).where(UserMcpServer.id == row.id))
    assert [s["id"] for s in migrated.credential_slots] == ["legacy_header_0"]
    assert migrated.encrypted_credentials
    assert migrated.encrypted_headers == ""
    from app.byok.crypto import decrypt_envelope
    values = json.loads(decrypt_envelope(
        migrated.encrypted_credentials, migrated.credentials_nonce,
        migrated.encrypted_credentials_key, key_version=migrated.credentials_key_version,
    ))
    assert values == {"legacy_header_0": "Bearer ghp_legacy"}


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


async def test_agent_tool_results_never_leak_credentials(db, user_a, monkeypatch):
    """Blocker 回归：manage_mcp_servers 的所有工具结果进模型上下文，
    任何 action 都不得携带 endpoint 明文 query 或 credential_values（PR #72 复审）。"""
    import json as _json

    from agent.mcp.manager import mcp_manager
    from agent.tools.mcp import _manage_mcp_servers

    async def _no_tools(_user_id):
        return []

    monkeypatch.setattr(mcp_manager, "list_user_tools", _no_tools)
    monkeypatch.setattr(mcp_manager, "invalidate_server", lambda *a, **k: None)

    created = await api.create_server(
        api.McpServerCreate(name="leaky", endpoint="https://mcp.example.com/rpc?key=SUPER_SECRET_123",
                            credential_slots=[{"id": "api_key", "label": "服务 Key", "target": "query", "name": "key"}],
                            credential_values={"api_key": "SUPER_SECRET_123"}),
        user=user_a, db=db,
    )
    owner_view = _json.dumps(created, ensure_ascii=False)
    assert "SUPER_SECRET_123" in owner_view  # owner 编辑视图明文回显是产品定稿

    # Agent 工具的全部读路径与写路径结果都不出现明文
    actions = [
        {"action": "list"},
        {"action": "update", "server_id": created["id"], "enabled": True},
        {"action": "enable", "server_id": created["id"]},
        {"action": "disable", "server_id": created["id"]},
        {"action": "test_connection", "server_id": created["id"]},
    ]
    from app.core.config import get_settings

    settings = get_settings()
    for args in actions:
        result = await _manage_mcp_servers(db, user_a.id, dict(args))
        serialized = _json.dumps(result, ensure_ascii=False, default=str)
        assert "SUPER_SECRET_123" not in serialized, f"{args['action']} 泄漏了凭据明文: {serialized[:200]}"
        if "server" in result and isinstance(result["server"], dict):
            assert "credential_values" not in result["server"], f"{args['action']} 返回了 credential_values"

    # 安全视图保留管理字段：槽位定义与 configured 状态在，值不在
    listed = await _manage_mcp_servers(db, user_a.id, {"action": "list"})
    item = listed["items"][0]
    assert item["credential_state"]["configured"] is True
    assert item["credential_slots"][0]["id"] == "api_key"
    assert item["endpoint"] == "https://mcp.example.com/rpc"  # 明文 query 已整体去除

    # settings= 参数路径（API 侧同函数）同样不泄漏
    row = (await db.execute(select(UserMcpServer).where(UserMcpServer.name == "leaky"))).scalar_one()
    safe = api.agent_safe_server_view(row, settings)
    assert "SUPER_SECRET_123" not in _json.dumps(safe, ensure_ascii=False)


async def test_patch_explicit_clear_purges_credentials(db, user_a):
    """P2 后端语义：credential_slots=[] + credential_values={} 是显式清空，
    必须真正删除已存凭据（前端据此把「清空」翻译成显式提交）。"""
    created = await api.create_server(
        api.McpServerCreate(name="purge", endpoint="https://mcp.example.com",
                            credential_slots=[{"id": "api_key", "label": "服务 Key", "target": "query", "name": "key"}],
                            credential_values={"api_key": "SUPER_SECRET_123"}),
        user=user_a, db=db,
    )
    assert created["credential_state"]["configured"] is True
    updated = await api.update_server(
        created["id"],
        api.McpServerPatch(credential_slots=[], credential_values={}),
        user=user_a, db=db,
    )
    assert updated["credential_slots"] == []
    assert updated["credential_state"]["configured"] is False
    row = (await db.execute(select(UserMcpServer).where(UserMcpServer.name == "purge"))).scalar_one()
    assert not row.encrypted_credentials

    # 未提供（None）= 保留原值，两条路径语义互不干扰
    created2 = await api.create_server(
        api.McpServerCreate(name="keep", endpoint="https://mcp.example.com",
                            credential_slots=[{"id": "api_key", "label": "服务 Key", "target": "query", "name": "key"}],
                            credential_values={"api_key": "KEEP_ME_456"}),
        user=user_a, db=db,
    )
    await api.update_server(created2["id"], api.McpServerPatch(enabled=False), user=user_a, db=db)
    row2 = (await db.execute(select(UserMcpServer).where(UserMcpServer.name == "keep"))).scalar_one()
    assert row2.encrypted_credentials  # 未提交凭据字段 → 保留
