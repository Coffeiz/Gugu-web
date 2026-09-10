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


@pytest.mark.asyncio
async def test_anthropic_branch_forwards_tools_without_tool_choice(monkeypatch):
    """工具声明要跟着分支一起发，但不能设 tool_choice——那会让前缀缓存失效。"""
    fake = _FakeAnthropic()
    monkeypatch.setattr(providers, "build_anthropic_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: SimpleNamespace(supports_active_cache=lambda model: True))
    tools = [{"name": "read_file", "description": "读文件", "input_schema": {}}]
    await provider_runner._anthropic("stable system", "user", _anthropic_ai(), 100,
                                     tools=tools)
    assert fake.kwargs["tools"] == tools
    assert "tool_choice" not in fake.kwargs


@pytest.mark.asyncio
async def test_openai_branch_forwards_tools_like_main_run(monkeypatch):
    """OpenAI 兼容端沿用主 run 的 build_tool_params 形状，前缀才能对上。"""
    fake = _FakeOpenAI()
    monkeypatch.setattr(providers, "build_openai_client", lambda ai, timeout: fake)
    tools = [{"type": "function", "function": {"name": "read_file"}}]
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: SimpleNamespace(
            supports_explicit_cache=lambda model: False,
            build_structured_output=lambda ai: {},
            build_openai_thinking_kwargs=lambda ai, thinking=None: {},
            build_tool_params=lambda ai, items: {"tools": items, "tool_choice": "auto"},
        ))
    await provider_runner._openai("stable system", "user", _openai_ai(), 100, tools=tools)
    assert fake.kwargs["tools"] == tools
    assert fake.kwargs["tool_choice"] == "auto"


@pytest.mark.asyncio
async def test_branch_without_tools_stays_unchanged(monkeypatch):
    """没有工具声明的分支（反思/知识）不受影响，不额外加 tools 参数。"""
    fake = _FakeAnthropic()
    monkeypatch.setattr(providers, "build_anthropic_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: SimpleNamespace(supports_active_cache=lambda model: True))
    await provider_runner._anthropic("stable system", "user", _anthropic_ai(), 100)
    assert "tools" not in fake.kwargs
