"""PRD-LLM-7 P1/P2：本地部署配置与能力覆盖回归。"""

from types import SimpleNamespace

import pytest

from agent import providers
from agent.loop_drivers import OpenAIDriver
from app.api.v1 import agent_admin


def _preset(**extra):
    item = {
        "id": "local-1",
        "name": "本地测试模型",
        "provider": "local",
        "local_runtime": "vllm",
        "deployment_mode": "local",
        "base_url": "http://127.0.0.1:8000/v1",
        "model": "local-model",
        "api_key": "",
    }
    item.update(extra)
    return item


@pytest.mark.asyncio
async def test_capability_override_persists_and_invalidates_active_runtime(monkeypatch):
    override = {"ai_presets": {"active_id": "local-1", "items": [_preset()]}}
    monkeypatch.setattr(agent_admin, "_read_override", lambda: override)

    result = await agent_admin.update_capability_overrides(
        "local-1", {"tools": True, "structured_json": True})

    assert result == {"capability_overrides": {"tools": True, "structured_json": True}}
    item = override["ai_presets"]["items"][0]
    assert item["capability_overrides"] == {"tools": True, "structured_json": True}
    assert item["capability_checked_at"] == ""
    assert item["capability_fingerprint"] == ""


@pytest.mark.asyncio
async def test_capability_probe_persists_fingerprint_and_results(monkeypatch):
    override = {"ai_presets": {"active_id": "local-1", "items": [_preset()]}}
    monkeypatch.setattr(agent_admin, "_read_override", lambda: override)
    async def fake_probe(item):
        return _probe_result()

    monkeypatch.setattr(agent_admin, "_probe_local_capabilities", fake_probe)

    result = await agent_admin.probe_llm_capabilities("local-1")

    item = override["ai_presets"]["items"][0]
    assert result["fingerprint"] == item["capability_fingerprint"]
    assert result["checked_at"] == item["capability_checked_at"]
    assert item["capability_probe"]["tools"]["status"] == "支持"
    assert result["declared_capabilities"]["provider"] == "local"


def _probe_result():
    return {
        key: {"status": "支持", "detail": "HTTP 200"}
        for key in ("chat", "stream", "tools", "json_object", "json_schema")
    } | {"reasoning": {"status": "未检测", "detail": "人工确认"}}


def test_local_runtime_model_defaults_and_override_precedence():
    ai = SimpleNamespace(
        provider="local", local_runtime="llama.cpp", base_url="", model="demo",
        capability_overrides={"tools": True, "vision": False}, api_key="do-not-expose")
    snapshot = providers.capability_snapshot(ai)
    assert snapshot["tools"] is True
    assert snapshot["vision"] is False
    assert snapshot["overrides"] == {"tools": True, "vision": False}
    assert "do-not-expose" not in repr(snapshot)


def test_local_without_tool_capability_does_not_send_tool_schemas(monkeypatch):
    monkeypatch.setattr(providers, "build_openai_client", lambda ai, timeout: object())
    ai = SimpleNamespace(
        provider="local", local_runtime="vllm", base_url="http://127.0.0.1:8000/v1",
        model="demo", max_tokens=32, temperature=0)
    _, context = OpenAIDriver().prepare(["web_search"], ai, [], None)
    assert context.tools == []
