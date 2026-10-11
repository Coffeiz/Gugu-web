"""问候遵循用户协议，推理内容不得进入可见正文或续接历史。"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from agent import greeting, providers
from agent.llm import llm_select, modelctx
from app.byok import service as byok_service
from app.core.config import AISettings


class _Client:
    def __init__(self, response):
        self.create = AsyncMock(return_value=response)
        self.responses = SimpleNamespace(create=self.create)
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        self.messages = SimpleNamespace(create=self.create)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None


@pytest.fixture
def configure(monkeypatch):
    def bind(ai, response):
        client = _Client(response)
        monkeypatch.setattr(llm_select, "resolve_run_config_for_user", AsyncMock(
            return_value=SimpleNamespace(model=ai)))
        release = Mock()
        monkeypatch.setattr(llm_select, "release", release)
        monkeypatch.setattr(modelctx, "mark_user_scope", lambda: None)
        monkeypatch.setattr(modelctx, "set_model_cfg", lambda model: None)
        monkeypatch.setattr(modelctx, "effective_ai", lambda settings: ai)
        monkeypatch.setattr(byok_service, "resolve_and_bind_user_embedding", AsyncMock())
        monkeypatch.setattr(greeting, "_recent_context", AsyncMock(return_value=""))
        monkeypatch.setattr(providers, "build_openai_client", lambda *args: client)
        monkeypatch.setattr(providers, "build_anthropic_client", lambda *args: client)
        return client, release
    return bind


@pytest.mark.asyncio
@pytest.mark.parametrize("persistence", ["off", "continuation"])
async def test_responses_greeting_excludes_reasoning_and_does_not_replay_state(configure, persistence):
    ai = AISettings(provider="minimax", model="MiniMax-M3", api_format="responses",
                    thinking="adaptive", reasoning_persistence=persistence)
    client, release = configure(ai, {"output": [
        {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "内部规划"}]},
        {"type": "message", "content": [{"type": "output_text", "text": "回来啦，今天过得好吗？"}]},
    ]})
    result = await greeting._generate_uncached(None, 7, None)
    assert result == "回来啦，今天过得好吗？"
    request = client.create.call_args.kwargs
    assert "input" in request and "messages" not in request
    assert request["input"][0]["role"] == "user"
    assert len(request["input"]) == 1
    assert request["max_output_tokens"] >= 2048
    assert request["reasoning"] == {"effort": "high"}
    assert "previous_response_id" not in request and "include" not in request
    release.assert_called_once_with(ai)


@pytest.mark.asyncio
async def test_responses_reasoning_only_returns_no_visible_greeting(configure):
    ai = AISettings(provider="minimax", model="MiniMax-M3", api_format="responses")
    configure(ai, {"output": [{"type": "reasoning", "content": [
        {"type": "reasoning_text", "text": "内部规划"}]}]})
    assert await greeting._generate_uncached(None, 7, None) == ""


@pytest.mark.asyncio
@pytest.mark.parametrize("content,expected", [
    ("<think>内部规划</think>回来啦！", "回来啦！"),
    ("<think>被截断的内部规划", ""),
])
async def test_chat_greeting_removes_closed_and_truncated_thinking(configure, content, expected):
    ai = AISettings(provider="minimax", model="MiniMax-M3", api_format="openai")
    client, _ = configure(ai, SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content=content))]))
    assert await greeting._generate_uncached(None, 7, None) == expected
    assert "messages" in client.create.call_args.kwargs


@pytest.mark.asyncio
async def test_anthropic_greeting_uses_only_text_blocks(configure):
    ai = AISettings(provider="minimax", model="MiniMax-M3", api_format="anthropic")
    configure(ai, SimpleNamespace(content=[
        SimpleNamespace(type="thinking", thinking="内部规划"),
        SimpleNamespace(type="text", text="回来啦！"),
    ]))
    assert await greeting._generate_uncached(None, 7, None) == "回来啦！"
