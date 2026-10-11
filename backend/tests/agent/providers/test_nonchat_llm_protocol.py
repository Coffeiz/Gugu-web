"""非聊天调用遵循配置协议、隔离推理输出和状态、保留 JSON 业务结果。"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent import providers
from agent.context import provider_runner
from agent.conversation import session_metadata
from agent.llm import modelctx
from agent.providers.standalone import output_budget
from app.core.config import AISettings


class _Client:
    def __init__(self):
        self.responses = SimpleNamespace(create=AsyncMock(return_value={
            "output_text": "内部规划与正文的错误聚合",
            "output": [
                {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "内部规划"}]},
                {"type": "message", "content": [{"type": "output_text", "text": '{"ok":true}'}]},
            ],
        }))
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=AsyncMock()))

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None


@pytest.fixture
def responses_model(monkeypatch):
    ai = AISettings(provider="minimax", model="MiniMax-M3", api_format="responses",
                    thinking="adaptive", reasoning_persistence="continuation")
    client = _Client()
    monkeypatch.setattr(providers, "build_openai_client", lambda *args: client)
    monkeypatch.setattr(modelctx, "effective_ai", lambda settings: ai)
    monkeypatch.setattr("agent.usage.record_current_usage", AsyncMock())
    return ai, client


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["text", "json", "messages", "title", "summary"])
async def test_nonchat_responses_uses_visible_message_and_never_replays_reasoning(responses_model, entry):
    ai, client = responses_model
    settings = SimpleNamespace(ai=ai)
    if entry == "text":
        result = await provider_runner.complete_text("规则", "输入", settings, 40)
    elif entry == "json":
        result = await provider_runner.complete_json("规则", "输入", settings, max_tokens=80)
    elif entry == "messages":
        result = await provider_runner.complete_messages("规则", [], "输入", settings, 900, json_mode=True)
    elif entry == "title":
        result = await session_metadata.generate_title("用户输入", "回复", settings, False)
    else:
        result = await session_metadata.generate_summary("合成对话", settings, False)
    assert result == ({"ok": True} if entry in {"json", "messages"} else '{"ok":true}')
    client.chat.completions.create.assert_not_awaited()
    request = client.responses.create.call_args.kwargs
    assert request["max_output_tokens"] >= 4096
    assert len(request["input"]) == 1
    assert "previous_response_id" not in request and "include" not in request


@pytest.mark.asyncio
async def test_json_thinking_override_does_not_mutate_configured_model(responses_model):
    ai, client = responses_model
    assert await provider_runner.complete_json("规则", "输入", None, thinking="disabled") == {"ok": True}
    assert ai.thinking == "adaptive"
    assert "reasoning" not in client.responses.create.call_args.kwargs


def test_budget_keeps_unlimited_setting_and_plain_model_budget():
    ai = AISettings(provider="openai", model="gpt-4o", api_format="responses")
    assert output_budget(ai, None) is None
    assert output_budget(ai, 80) == 80


def test_json_parser_never_reads_an_object_from_thinking():
    assert provider_runner._parse_json('<think>{"ok":false}</think>{"ok":true}') == {"ok": True}
    assert provider_runner._parse_json('<think>{"ok":false}') == {}


@pytest.mark.asyncio
async def test_email_translation_uses_responses_and_keeps_source_urls(responses_model, monkeypatch):
    from app.api.v1 import email_admin
    ai, client = responses_model
    monkeypatch.setattr(email_admin, "get_settings", lambda: SimpleNamespace(ai=ai))
    client.responses.create.return_value = {"output": [
        {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "内部规划"}]},
        {"type": "message", "content": [{"type": "output_text", "text":
            '{"subject":"Update","title":"Update","body":"News","actions":[{"label":"Read","url":"https://wrong.example"}]}'}]},
    ]}
    result = await email_admin._translate_with_model(email_admin.EmailDraft(
        subject="更新", title="更新", body="新闻", actions=[{"label": "阅读", "url": "https://example.com"}]), ["en-US"])
    assert result["en-US"].body == "News"
    assert result["en-US"].actions[0].url == "https://example.com"
    client.chat.completions.create.assert_not_awaited()


@pytest.mark.asyncio
async def test_admin_responses_capabilities_probe_sends_native_requests(monkeypatch):
    import httpx
    from app.api.v1.agent_admin import _probe_local_capabilities
    requests = []

    async def handle(request):
        import json
        payload = json.loads(request.content)
        requests.append(payload)
        assert request.url.path == "/v1/responses"
        assert "input" in payload and "messages" not in payload
        return httpx.Response(200, content=b'data: {"type":"response.created"}\n\n')

    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original(
        transport=httpx.MockTransport(handle), **kwargs))
    result = await _probe_local_capabilities({
        "provider": "openai", "api_format": "responses", "model": "gpt-4o",
        "base_url": "https://example.com/v1", "api_key": "synthetic-key"})
    assert len(requests) == 5
    assert all(result[key]["status"] == "支持" for key in [
        "chat", "stream", "tools", "json_object", "json_schema"])
    assert requests[2]["tools"][0]["name"] == "probe_noop"
    assert requests[4]["text"]["format"]["schema"]["properties"]["ok"] == {"type": "boolean"}
