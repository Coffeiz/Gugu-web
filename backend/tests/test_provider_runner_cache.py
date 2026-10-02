"""分支 provider 调用与主对话缓存策略一致性回归。"""
from types import SimpleNamespace

import pytest

from agent.context import provider_runner
from agent import providers


class _Adapter(providers.ProviderAdapter):
    """保留完整适配器契约，各用例仅替换所验证的能力。"""
    def __init__(self, **overrides):
        self.__dict__.update(overrides)


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
        lambda ai: _Adapter(supports_active_cache=lambda model: True))
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
        lambda ai: _Adapter(supports_active_cache=lambda model: False))
    await provider_runner._anthropic("stable system", "user", _anthropic_ai(), 100)
    assert fake.kwargs["system"] == "stable system"


@pytest.mark.asyncio
async def test_openai_branch_marks_system_cache_control_when_explicit(monkeypatch):
    fake = _FakeOpenAI()
    monkeypatch.setattr(providers, "build_openai_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: _Adapter(
            supports_explicit_cache=lambda model: True,
            build_structured_output=lambda ai: {},
            build_openai_thinking_kwargs=lambda ai, thinking=None: {},
        ))
    await provider_runner._openai(
        "stable system", "user", _openai_ai(), 100,
        history=[{"role": "system", "content": "session snapshot"}],
    )
    system, user = fake.kwargs["messages"]
    assert system["role"] == "system"
    assert system["content"] == [
        {
            "type": "text",
            "text": "stable system\n\n---\n\nsession snapshot",
            "cache_control": {"type": "ephemeral"},
        },
    ]
    # user 消息不打断点（内容含时间戳每轮必变，锚定无意义）。
    assert user == {"role": "user", "content": "user"}


@pytest.mark.asyncio
async def test_openai_branch_plain_messages_without_explicit_cache(monkeypatch):
    fake = _FakeOpenAI()
    monkeypatch.setattr(providers, "build_openai_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: _Adapter(
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
        lambda ai: _Adapter(supports_active_cache=lambda model: True))
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
        lambda ai: _Adapter(
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
        lambda ai: _Adapter(supports_active_cache=lambda model: True))
    await provider_runner._anthropic("stable system", "user", _anthropic_ai(), 100)
    assert "tools" not in fake.kwargs


@pytest.mark.asyncio
async def test_anthropic_branch_omits_empty_system(monkeypatch):
    """空 system 不发该参数（手动 /compact 的追加式调用没有主 run 的 system）。"""
    fake = _FakeAnthropic()
    monkeypatch.setattr(providers, "build_anthropic_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: _Adapter(supports_active_cache=lambda model: True))
    await provider_runner._anthropic("", "user", _anthropic_ai(), 100)
    assert "system" not in fake.kwargs


@pytest.mark.asyncio
async def test_complete_messages_omits_thinking_like_main_run(monkeypatch):
    """追加式分支与主 run 逐参数对齐：主 run 不发 thinking（adapter 返回空），
    分支也不得手拼 thinking 参数，否则 provider 缓存键不同整段 miss。"""
    fake = _FakeAnthropic()
    monkeypatch.setattr(providers, "build_anthropic_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: _Adapter(
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
        lambda ai: _Adapter(
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


@pytest.mark.asyncio
async def test_anthropic_append_branch_sanitizes_history_before_appending_delta(monkeypatch):
    fake = _FakeAnthropic()
    monkeypatch.setattr(providers, "build_anthropic_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: _Adapter(
            protocol_format=lambda ai: "anthropic",
            supports_active_cache=lambda model: False,
            build_anthropic_thinking_params=lambda ai: {},
            build_anthropic_generation_params=lambda ai: {},
        ))
    history = [
        {"role": "user", "content": [{"type": "text", "text": "旧问题"}]},
        {"role": "assistant", "content": [
            {"type": "reasoning_content", "text": "unsupported"},
            {"type": "text", "text": "旧回答"},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "stale", "content": "orphan"},
        ]},
    ]
    ai = SimpleNamespace(model="m-test", provider="anthropic")

    await provider_runner.complete_messages(
        "stable system", history, "追加反思任务", settings=SimpleNamespace(ai=ai),
    )

    assert fake.kwargs["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "旧问题"}]},
        {"role": "assistant", "content":[
            {"type": "text", "text": "旧回答", "cache_control": {"type": "ephemeral"}},
        ]},
        {"role": "user", "content": "追加反思任务"},
    ]


@pytest.mark.asyncio
async def test_minimax_anthropic_branch_sends_rendered_tool_history_without_reprojection(monkeypatch):
    """wire 历史二次按 canonical 渲染会丢工具事件，必须保留 Anthropic 工具往返。"""
    from agent.context.provider_conversation import ProviderConversation

    fake = _FakeAnthropic()
    monkeypatch.setattr(providers, "build_anthropic_client", lambda ai, timeout: fake)
    history = ProviderConversation([
        {"role": "user", "content": "执行查询"},
        {"role": "assistant", "content": [
            {"type": "tool_use", "id": "call-1", "name": "lookup", "input": {"q": "x"}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "call-1", "content": "结果"},
        ]},
    ])
    ai = SimpleNamespace(
        model="MiniMax-M3", provider="minimax", api_format="anthropic",
        base_url="https://api.minimaxi.com/anthropic",
    )

    await provider_runner.complete_messages(
        "stable system", history, "继续处理", settings=SimpleNamespace(ai=ai),
    )

    sent = fake.kwargs["messages"]
    assert sent[0] == {"role": "user", "content": "执行查询"}
    assert sent[1]["content"][0]["type"] == "tool_use"
    assert sent[1]["content"][0]["input"] == {"q": "x"}
    assert sent[2]["content"][0]["type"] == "tool_result"
    assert sent[2]["content"][0]["tool_use_id"] == "call-1"
    assert sent[-1] == {"role": "user", "content": "继续处理"}


@pytest.mark.asyncio
async def test_minimax_prefix_projection_remains_wire_shaped_through_branch_request(monkeypatch):
    """从 canonical 工具轮次到 Anthropic HTTP payload 只投影一次，避免二次转换造成 400。"""
    from agent.context.prefix_history import render_branch_prefix

    fake = _FakeAnthropic()
    monkeypatch.setattr(providers, "build_anthropic_client", lambda ai, timeout: fake)
    ai = SimpleNamespace(
        model="MiniMax-M3", provider="minimax", api_format="anthropic",
        base_url="https://api.minimaxi.com/anthropic",
    )
    canonical = [
        {"role": "user", "content_json": [{"type": "text", "text": "查一下"}]},
        {"role": "assistant", "content_json": [
            {"type": "tool_call", "id": "call-1", "name": "lookup", "arguments": {"q": "x"}},
        ]},
        {"role": "tool", "content_json": [
            {"type": "tool_result", "tool_call_id": "call-1", "content": "结果"},
        ]},
        {"role": "assistant", "content_json": [{"type": "text", "text": "查到了"}]},
    ]
    projection = render_branch_prefix(canonical, ai)
    expected_prefix = projection.to_messages()

    await provider_runner.complete_messages(
        "stable system", projection, "追加任务", settings=SimpleNamespace(ai=ai),
    )

    sent = fake.kwargs["messages"]
    assert [message["role"] for message in sent[:len(expected_prefix)]] == [
        message["role"] for message in expected_prefix
    ]
    assert sent[1]["content"][0]["type"] == "tool_use"
    assert sent[2]["content"][0]["type"] == "tool_result"
    assert sent[-1] == {"role": "user", "content": "追加任务"}
    assert canonical[1]["content_json"][0]["type"] == "tool_call"


@pytest.mark.asyncio
async def test_complete_messages_uses_responses_protocol_and_native_tool_schema(monkeypatch):
    class _FakeResponses:
        def __init__(self):
            self.kwargs = None

        @property
        def responses(self):
            return self

        async def create(self, **kwargs):
            self.kwargs = kwargs
            return SimpleNamespace(
                output_text='{"summary": "ok"}',
                output=[{"type": "message", "content": [
                    {"type": "output_text", "text": '{"summary": "ok"}'},
                ]}],
                usage=SimpleNamespace(
                    input_tokens=12,
                    output_tokens=3,
                    input_tokens_details=SimpleNamespace(cached_tokens=7),
                ),
            )

    fake = _FakeResponses()
    monkeypatch.setattr(providers, "build_openai_client", lambda ai, timeout: fake)
    monkeypatch.setattr(
        providers, "adapter_for",
        lambda ai: _Adapter(
            protocol_format=lambda ai: "responses",
            supports_responses_prompt_cache_key=lambda ai: False,
            build_responses_reasoning_params=lambda ai: {"reasoning": {"effort": "low"}},
            build_structured_output=lambda ai: {},
        ))
    ai = SimpleNamespace(
        model="qwen-test", provider="qwen", api_format="responses",
        reasoning_effort="low", store=False,
    )
    tools = [{"type": "function", "name": "read_file", "parameters": {"type": "object"}}]
    usage = []

    result = await provider_runner.complete_messages(
        "stable system", [{"role": "user", "content": "历史"}], "压缩指令",
        settings=SimpleNamespace(ai=ai), max_tokens=100, json_mode=True,
        tools=tools, usage_sink=usage,
    )

    assert result == {"summary": "ok"}
    assert fake.kwargs["instructions"] == "stable system"
    assert fake.kwargs["input"] == [
        {"role": "user", "content": "历史"},
        {"role": "user", "content": "压缩指令"},
    ]
    assert fake.kwargs["tools"] == tools
    assert fake.kwargs["max_output_tokens"] == 100
    assert fake.kwargs["store"] is False
    assert fake.kwargs["reasoning"] == {"effort": "low"}
    assert "previous_response_id" not in fake.kwargs
    assert usage == [{
        "input": 5, "fresh_input": 5, "output": 3,
        "cache_read": 7, "cache_write": 0,
    }]
