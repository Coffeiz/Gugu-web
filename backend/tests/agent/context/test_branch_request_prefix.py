"""反思追加请求在不同协议与续接开关下保持主请求前缀。"""
from collections import OrderedDict
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.context import provider_runner, reflection_snapshot
from agent.context.assembly import MessageArea
from agent.context.provider_conversation import ProviderConversation
from agent.context.reflection_snapshot import capture_reflection_snapshot
from agent.loop_drivers import AnthropicDriver
from agent.providers.openai_responses import OpenAIResponsesDriver


@pytest.mark.parametrize("block_system", [False, True])
@pytest.mark.asyncio
async def test_chat_completions_snapshot_does_not_duplicate_existing_system(monkeypatch, block_system):
    """关闭跨请求续接的 Chat Completions 也不能重复添加已有 system，破坏第一个 token 前缀。"""
    content = ([{"type": "text", "text": "基础系统"}, {"type": "text", "text": "会话快照"}]
               if block_system else "基础系统\n\n会话快照")
    history = ProviderConversation([
        {"role": "system", "content": content},
        {"role": "user", "content": "合成提问"},
        {"role": "assistant", "content": "合成回答"},
    ], fixed_prefix_size=1)
    original = history.to_messages()
    requests = []

    async def create(**kwargs):
        requests.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="{}"))], usage=None)

    monkeypatch.setattr("agent.providers.build_openai_client",
                        lambda *_args: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))))
    monkeypatch.setattr(provider_runner, "_record_usage", AsyncMock())
    ai = SimpleNamespace(provider="deepseek", model="deepseek-chat", api_format="openai",
                         thinking=None, reasoning_effort=None, max_tokens=128, reasoning_persistence="off")
    monkeypatch.setattr("agent.llm.modelctx.effective_ai", lambda _settings: ai)
    await provider_runner.complete_messages("基础系统", history, "只做反思", SimpleNamespace(ai=ai))

    assert requests[0]["messages"][:-1] == original
    assert requests[0]["messages"][-1] == {"role": "user", "content": "只做反思"}
    assert history.to_messages() == original


@pytest.mark.parametrize("replay_enabled", [False, True])
@pytest.mark.asyncio
async def test_responses_driver_snapshot_branch_keeps_exact_input_prefix(monkeypatch, replay_enabled):
    """Responses 开关续接均保留原生 input；开启时保留 encrypted reasoning 与调用 ID。"""
    requests = []
    response = {"id": "resp_synthetic", "output": [], "usage": {"input_tokens": 10, "output_tokens": 1}}

    class Stream:
        def __aiter__(self):
            async def events():
                yield SimpleNamespace(type="response.completed", response=SimpleNamespace(model_dump=lambda: response))
            return events()

        async def close(self):
            pass

    async def create(**kwargs):
        requests.append(copy.deepcopy(kwargs))
        return Stream() if kwargs.get("stream") else response

    client = SimpleNamespace(responses=SimpleNamespace(create=create))
    monkeypatch.setattr("agent.providers.build_openai_client", lambda *_args: client)
    monkeypatch.setattr("agent.usage.record_current_usage", AsyncMock())
    monkeypatch.setattr(reflection_snapshot, "_snapshots", OrderedDict())
    ai = SimpleNamespace(provider="openai", base_url="https://api.openai.com/v1", api_format="responses",
                         model="gpt-synthetic", max_tokens=128, thinking=None, reasoning_effort=None,
                         include_encrypted_reasoning=True, reasoning_persistence="continuation" if replay_enabled else "off")
    monkeypatch.setattr("agent.llm.modelctx.effective_ai", lambda _settings: ai)
    area = MessageArea.from_canonical_messages([
        {"role": "system", "content": "基础系统"},
        {"role": "system", "content": "会话快照"},
        {"role": "user", "content": "合成提问"},
        {"role": "assistant", "content": [{"type": "tool_call", "id": "call_synthetic",
            "name": "demo", "arguments": {"value": 7}, "responses_item_id": "fc_synthetic"}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_call_id": "call_synthetic", "content": "合成结果"}]},
    ], fixed_prefix_size=2, render_options={"api_format": "responses"})
    tool = {"type": "function", "function": {"name": "demo", "parameters": {"type": "object"}}}
    driver = OpenAIResponsesDriver()
    _, ctx = driver.prepare(["demo"], ai, area, "基础系统",
                            tool_snapshot=SimpleNamespace(openai_schemas=lambda _names: [tool]))
    driver.configure_reasoning_replay(ctx, enabled=replay_enabled)
    if replay_enabled:
        ctx.reasoning_items = [{"type": "reasoning", "id": "rs_synthetic", "summary": [],
                                "encrypted_content": "synthetic-encrypted"}]
    async for _ in driver.run_round(client, ctx, area):
        pass
    snapshot = capture_reflection_snapshot(user_id="synthetic", session_id=7, run_id="synthetic-run",
        ai=ai, system_prompt="基础系统", tools=ctx.tools, messages=area, reply_text="合成收尾")
    original = snapshot.history.to_messages()
    await provider_runner.complete_messages("基础系统", snapshot.history, "只做反思", SimpleNamespace(ai=ai), tools=list(snapshot.tools))

    main, branch = requests
    assert branch["input"][:len(main["input"])] == main["input"]
    assert branch["instructions"] == main["instructions"]
    assert branch["tools"] == main["tools"]
    assert branch.get("prompt_cache_key") == main.get("prompt_cache_key")
    assert branch.get("reasoning") == main.get("reasoning")
    assert branch["store"] == main["store"] == False
    assert "previous_response_id" not in branch
    assert any(item.get("type") == "reasoning" for item in branch["input"]) is replay_enabled
    assert snapshot.history.to_messages() == original


@pytest.mark.parametrize("thinking", [None, "disabled"])
@pytest.mark.asyncio
async def test_anthropic_without_continuation_keeps_main_request_prefix(monkeypatch, thinking):
    """未载入私有续接状态时，普通文本/工具前缀也必须保持一致，不能凭空补推理块。"""
    from agent.providers.message_utils import _without_cache_control

    requests = []

    async def create(**kwargs):
        requests.append(copy.deepcopy(kwargs))
        return SimpleNamespace(content=[SimpleNamespace(type="text", text="{}")], usage=None)

    monkeypatch.setattr("agent.providers.build_anthropic_client",
                        lambda *_args: SimpleNamespace(messages=SimpleNamespace(create=create)))
    monkeypatch.setattr(provider_runner, "_record_usage", AsyncMock())
    monkeypatch.setattr(reflection_snapshot, "_snapshots", OrderedDict())
    ai = SimpleNamespace(provider="minimax", model="MiniMax-M3.1-Flash-Preview", api_format="anthropic",
                         max_tokens=4096, thinking=thinking, reasoning_effort=None, reasoning_persistence="off")
    monkeypatch.setattr("agent.llm.modelctx.effective_ai", lambda _settings: ai)
    area = MessageArea.from_canonical_messages([
        {"role": "user", "content": "合成提问"},
        {"role": "assistant", "content": [{"type": "tool_call", "id": "call_synthetic", "name": "demo", "arguments": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_call_id": "call_synthetic", "content": "合成结果"}]},
    ], render_options={"api_format": "anthropic"})
    tool = {"name": "demo", "input_schema": {"type": "object"}}
    driver = AnthropicDriver()
    client, ctx = driver.prepare(["demo"], ai, area, "基础系统",
                                tool_snapshot=SimpleNamespace(anthropic_schemas=lambda _names: [tool]))

    async def stream_round(_client, kwargs, _adapter):
        requests.append(copy.deepcopy(kwargs))
        yield "final", SimpleNamespace(content=[SimpleNamespace(type="text", text="合成收尾")],
                                        stop_reason="end_turn", usage=SimpleNamespace(input_tokens=10, output_tokens=1))

    async for _ in driver.run_round(client, ctx, area, stream_round=stream_round):
        pass
    snapshot = capture_reflection_snapshot(user_id="synthetic", session_id=7, run_id="synthetic-run",
        ai=ai, system_prompt="基础系统", tools=ctx.tools, messages=area, reply_text="合成收尾")
    await provider_runner.complete_messages("基础系统", snapshot.history, "只做反思", SimpleNamespace(ai=ai), tools=list(snapshot.tools))
    main, branch = requests
    assert _without_cache_control(branch["messages"][:len(main["messages"])]) == _without_cache_control(main["messages"])
    assert branch["system"] == main["system"]
    assert branch["tools"] == main["tools"]
    assert branch.get("thinking") == main.get("thinking")
    assert not any(block.get("type") == "thinking" for row in branch["messages"]
                   for block in row["content"] if isinstance(block, dict))
