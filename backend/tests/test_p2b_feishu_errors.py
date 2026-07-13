"""P2-b feishu.py：tenant_access_token 失败不泄露响应体、json.loads 解析失败按类型窄化。

不打真实飞书服务器；在 httpx 边界 mock。
"""
from __future__ import annotations

import json

import httpx
import pytest

from agent.adapters import feishu


class _FakeResp:
    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


@pytest.mark.asyncio
async def test_tenant_token_failure_does_not_leak_response_body(monkeypatch):
    """响应体可能回显 app_id/app_secret 片段——异常消息只能是通用文案，不能带原始 data。"""
    feishu._tenant_token_cache.clear()

    async def fake_post(self, url, json=None):
        return _FakeResp({"code": 99991663, "msg": "app secret 无效", "app_secret": "leaked-secret-value"})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    with pytest.raises(RuntimeError) as exc_info:
        await feishu._get_tenant_token("cli_test", "leaked-secret-value")

    assert "leaked-secret-value" not in str(exc_info.value)
    assert "leaked-secret-value" not in repr(exc_info.value)


@pytest.mark.asyncio
async def test_tenant_token_success_still_caches(monkeypatch):
    """确认脱敏改动没动到成功路径的行为（token 缓存）。"""
    feishu._tenant_token_cache.clear()

    async def fake_post(self, url, json=None):
        return _FakeResp({"code": 0, "tenant_access_token": "t-abc123", "expire": 7200})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    token = await feishu._get_tenant_token("cli_test", "secret")
    assert token == "t-abc123"
    assert "cli_test" in feishu._tenant_token_cache


# ── json.loads 窄化：只吞「内容不是合法 JSON」，不裸吞未知异常（P2-b §6）───────

def test_ingest_post_falls_back_on_malformed_json():
    from types import SimpleNamespace
    msg = SimpleNamespace(content="{not valid json", message_id="om_x")
    text, attachments = feishu._ingest_post(client=None, msg=msg, owner="u1")
    assert text == ""
    assert attachments == []


def test_extract_card_text_from_streaming_card_schema_2():
    """回归：streaming 卡片 schema 2.0 嵌套在 body.elements，不在顶层 elements
    （这是本 session 之前修的 bug，P2-b 的 except 收窄不能把它带崩）。"""
    content = {"schema": "2.0", "body": {"elements": [{"tag": "markdown", "content": "你好"}]}}
    assert feishu._extract_card_text(content) == "你好"
