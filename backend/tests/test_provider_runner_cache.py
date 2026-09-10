"""分支 provider 调用与主对话缓存策略一致性回归。"""
from types import SimpleNamespace

import pytest

from agent.context import provider_runner
from agent import providers


class _FakeAnthropic:
    def __init__(self):
        self.kwargs = None

    @property
    def messages(self):
        return self

    async def create(self, **kwargs):
        self.kwargs = kwargs
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text="ok")], usage=None)


class _FakeOpenAI:
    def __init__(self):
        self.kwargs = None

    @property
    def chat(self):
        return self

    @property
    def completions(self):
        return self

    async def create(self, **kwargs):
        self.kwargs = kwargs
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": 1}'))],
            usage=None)


def _anthropic_ai():
    return SimpleNamespace(model="claude-test", provider="anthropic")


def _openai_ai():
    return SimpleNamespace(model="m3-test", provider="minimax")


@pytest.mark.asyncio
async def test_anthropic_branch_marks_system_cache_control(monkeypatch):
    fake = _FakeAnthropic()
    monkeypatch.setattr(providers, "build_anthropic_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: SimpleNamespace(supports_active_cache=lambda model: True))
    await provider_runner._anthropic("stable system", "user", _anthropic_ai(), 100)
    assert fake.kwargs["system"] == [
        {"type": "text", "text": "stable system", "cache_control": {"type": "ephemeral"}},
    ]


@pytest.mark.asyncio
async def test_anthropic_branch_plain_system_without_active_cache(monkeypatch):
    fake = _FakeAnthropic()
    monkeypatch.setattr(providers, "build_anthropic_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: SimpleNamespace(supports_active_cache=lambda model: False))
    await provider_runner._anthropic("stable system", "user", _anthropic_ai(), 100)
    assert fake.kwargs["system"] == "stable system"


@pytest.mark.asyncio
async def test_openai_branch_marks_system_cache_control_when_explicit(monkeypatch):
    fake = _FakeOpenAI()
    monkeypatch.setattr(providers, "build_openai_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: SimpleNamespace(
            supports_explicit_cache=lambda model: True,
            build_structured_output=lambda ai: {},
            build_openai_thinking_kwargs=lambda ai, thinking=None: {},
        ))
    await provider_runner._openai("stable system", "user", _openai_ai(), 100)
    system, user = fake.kwargs["messages"]
    assert system["role"] == "system"
    assert system["content"] == [
        {"type": "text", "text": "stable system", "cache_control": {"type": "ephemeral"}},
    ]
    # user 消息不打断点（内容含时间戳每轮必变，锚定无意义）。
    assert user == {"role": "user", "content": "user"}


@pytest.mark.asyncio
async def test_openai_branch_plain_messages_without_explicit_cache(monkeypatch):
    fake = _FakeOpenAI()
    monkeypatch.setattr(providers, "build_openai_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: SimpleNamespace(
            supports_explicit_cache=lambda model: False,
            build_structured_output=lambda ai: {},
            build_openai_thinking_kwargs=lambda ai, thinking=None: {},
        ))
    await provider_runner._openai("stable system", "user", _openai_ai(), 100)
    assert fake.kwargs["messages"] == [
        {"role": "system", "content": "stable system"},
        {"role": "user", "content": "user"},
    ]
