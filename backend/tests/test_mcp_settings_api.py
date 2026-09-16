"""MCP1-004 验收：用户 MCP server 配置 CRUD、上限拒绝、凭据掩码、URL 校验、越权 404。

按仓库惯例直调路由函数（不起 TestClient）；URL 安全校验 monkeypatch 掉真实 DNS。
"""
from __future__ import annotations

import json

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import mcp_settings as api
from app.models import UserMcpServer


@pytest.fixture(autouse=True)
def _safe_url(monkeypatch):
    """单测不碰真实 DNS：endpoint 前置校验直接放行公网、拒绝内网样例由专门用例覆盖。"""
    monkeypatch.setattr(api, "url_is_safe", lambda url: None if "internal" not in url else "该地址指向内网/本机，出于安全考虑不予下载")


@pytest.fixture
def mcp_on(monkeypatch):
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.mcp, "enabled", True)


async def test_create_and_view_masks_credentials(db, user_a):
    created = await api.create_server(
        api.McpServerCreate(name="weather", endpoint="https://mcp.example.com/rpc",
                            headers={"Authorization": "Bearer sk-secret-value"}),
        user=user_a, db=db,
    )
    assert created["name"] == "weather"
    assert created["has_credentials"] is True
    assert created["headers"] == {"Authorization": "••••"}
    assert "sk-secret-value" not in json.dumps(created)

    # 密文落库：数据库行里没有明文凭据，且可解密回原值
    row = (await db.execute(select(UserMcpServer).where(UserMcpServer.name == "weather"))).scalar_one()
    stored = json.dumps({
        "enc": row.encrypted_headers, "nonce": row.headers_nonce, "key": row.encrypted_headers_key,
    })
    assert "sk-secret-value" not in stored
    assert row.encrypted_headers and row.encrypted_headers.startswith("")

    from app.byok.crypto import decrypt_envelope
    raw = decrypt_envelope(row.encrypted_headers, row.headers_nonce,
                           row.encrypted_headers_key, key_version=row.headers_key_version)
    assert json.loads(raw) == {"Authorization": "Bearer sk-secret-value"}


async def test_name_conflict_and_invalid_names(db, user_a):
    await api.create_server(api.McpServerCreate(name="weather", endpoint="https://mcp.example.com"),
                            user=user_a, db=db)
    with pytest.raises(HTTPException) as exc:
        await api.create_server(api.McpServerCreate(name="weather", endpoint="https://mcp2.example.com"),
                                user=user_a, db=db)
    assert "已存在" in exc.value.detail
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
                                                    tool_allowlist=[f"t{i}" for i in range(64)]),
                                user=user_a, db=db)


async def test_headers_clear_on_patch(db, user_a):
    created = await api.create_server(
        api.McpServerCreate(name="cred", endpoint="https://m.example.com",
                            headers={"Authorization": "Bearer x"}),
        user=user_a, db=db,
    )
    updated = await api.update_server(created["id"], api.McpServerPatch(headers={}), user=user_a, db=db)
    assert updated["has_credentials"] is False


async def test_test_connection_reports_tools(db, user_a, monkeypatch):
    created = await api.create_server(api.McpServerCreate(name="echo", endpoint="https://m.example.com"),
                                      user=user_a, db=db)

    class FakeClient:
        def __init__(self, endpoint, headers=None, timeout_seconds=30.0):
            pass

        async def list_tools(self):
            return {"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}

    monkeypatch.setattr("agent.mcp.client.McpClient", FakeClient)
    result = await api.test_connection(created["id"], user=user_a, db=db)
    assert result["ok"] is True
    assert result["tool_count"] == 1

    class DeadClient:
        def __init__(self, endpoint, headers=None, timeout_seconds=30.0):
            pass

        async def list_tools(self):
            return {"error": "无法连接 MCP server，请检查地址与网络", "error_kind": "network"}

    monkeypatch.setattr("agent.mcp.client.McpClient", DeadClient)
    failed = await api.test_connection(created["id"], user=user_a, db=db)
    assert failed["ok"] is False
    assert "无法连接" in failed["error"]
