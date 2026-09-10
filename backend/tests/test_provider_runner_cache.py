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


@pytest.mark.asyncio
async def test_complete_messages_omits_thinking_like_main_run(monkeypatch):
    """追加式分支与主 run 逐参数对齐：主 run 不发 thinking（adapter 返回空），
    分支也不得手拼 thinking 参数，否则 provider 缓存键不同整段 miss。"""
    fake = _FakeAnthropic()
    monkeypatch.setattr(providers, "build_anthropic_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: SimpleNamespace(
            protocol_format=lambda ai: "anthropic",
            supports_active_cache=lambda model: True,
            build_anthropic_thinking_params=lambda ai: {},
            build_anthropic_generation_params=lambda ai: {},
        ))
    ai = SimpleNamespace(model="MiniMax-M3", provider="minimax", thinking="adaptive")
    await provider_runner.complete_messages(
        "stable system", [{"role": "user", "content": "历史"}], "压缩指令",
        settings=SimpleNamespace(ai=ai), tools=[{"name": "read_file"}])
    assert "thinking" not in fake.kwargs


@pytest.mark.asyncio
async def test_complete_messages_merges_main_run_generation_params(monkeypatch):
    """adapter 提供的 thinking/generation 参数必须原样带上，与主 run 同源。"""
    fake = _FakeAnthropic()
    monkeypatch.setattr(providers, "build_anthropic_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: SimpleNamespace(
            protocol_format=lambda ai: "anthropic",
            supports_active_cache=lambda model: True,
            build_anthropic_thinking_params=lambda ai: {"thinking": {"type": "enabled"}},
            build_anthropic_generation_params=lambda ai: {"metadata": {"x": 1}},
        ))
    ai = SimpleNamespace(model="m-test", provider="minimax", thinking="adaptive")
    await provider_runner.complete_messages(
        "stable system", [{"role": "user", "content": "历史"}], "压缩指令",
        settings=SimpleNamespace(ai=ai))
    assert fake.kwargs["thinking"] == {"type": "enabled"}
    assert fake.kwargs["metadata"] == {"x": 1}
