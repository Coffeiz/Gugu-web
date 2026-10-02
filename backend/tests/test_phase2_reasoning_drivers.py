from types import SimpleNamespace
import json

import pytest

from agent.loop_drivers import (
    AnthropicDriver,
    OpenAIDriver,
    RoundResult,
    NormalizedToolCall,
)
from agent.context.canonical_context import digest
from agent.context.assembly import MessageArea
from agent.context.provider_conversation import ProviderConversation
from agent.providers.openai_responses import (
    OpenAIResponsesDriver,
    ResponsesCompatibilityError,
    _ResponsesCtx,
    _ResponsesRaw,
    _responses_input,
    _responses_instructions,
    _responses_prompt_cache_key,
)
from agent.usage import normalize_responses_usage


def _anthropic_result():
    return RoundResult(
        text="查一下",
        tool_calls=[NormalizedToolCall("call-1", "calendar_list", {"date": "2026-09-05"})],
        raw=[
            {"type": "thinking", "thinking": "private", "signature": "sig-1"},
            {"type": "redacted_thinking", "data": "opaque"},
            {"type": "text", "text": "查一下"},
            {"type": "tool_use", "id": "call-1", "name": "calendar_list", "input": {"date": "2026-09-05"}},
        ],
    )


def _responses_adapter():
    return SimpleNamespace(
        render_history=lambda messages: messages.provider_projection(),
        build_responses_reasoning_params=lambda _ai: {},
    )


def test_responses_input_converts_chat_text_blocks_without_changing_other_blocks():
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "第一段", "source": "history"},
                {"type": "input_text", "text": "第二段"},
                {"type": "input_image", "image_url": "data:image/png;base64,AAAA"},
            ],
        },
    ]

    assert _responses_input(messages) == [{
        "role": "user",
        "content": [
            {"type": "input_text", "text": "第一段", "source": "history"},
            {"type": "input_text", "text": "第二段"},
            {"type": "input_image", "image_url": "data:image/png;base64,AAAA"},
        ],
    }]
    assert messages[0]["content"][0]["type"] == "text"


def test_responses_input_omits_empty_messages_but_preserves_nonempty_structured_blocks():
    assert _responses_input([
        {"role": "assistant", "content": ""},
        {"role": "assistant", "content": "  \n"},
        {"role": "user", "content": []},
        {"role": "user", "content": [{"type": "input_text", "text": "  "}]},
        {
            "role": "user",
            "content": [{"type": "input_image", "image_url": "data:image/png;base64,AAAA"}],
        },
        {"role": "user", "content": [{"type": "input_text", "text": "继续"}]},
    ]) == [
        {
            "role": "user",
            "content": [{"type": "input_image", "image_url": "data:image/png;base64,AAAA"}],
        },
        {"role": "user", "content": [{"type": "input_text", "text": "继续"}]},
    ]


def test_responses_input_converts_text_blocks_on_assistant_tool_call_messages():
    assert _responses_input([{
        "role": "assistant",
        "content": [{"type": "text", "text": "准备调用工具"}],
        "tool_calls": [{
            "id": "call-1",
            "function": {"name": "probe", "arguments": "{}"},
        }],
    }]) == [
        {"role": "assistant", "content": [{"type": "input_text", "text": "准备调用工具"}]},
        {
            "type": "function_call",
            "id": "fc_legacy_" + digest({"call_id": "call-1", "occurrence": 0}, length=24),
            "call_id": "call-1", "name": "probe", "arguments": "{}",
        },
    ]


def test_responses_input_replays_output_item_id_separately_from_call_id():
    from agent.context.canonical_tool_history import canonical_tool_round
    from agent.context.history import _openai_tool_call

    call = NormalizedToolCall(
        id="call_123", name="probe", input={},
        raw_arguments="{}", responses_item_id="fc_456",
    )
    canonical = canonical_tool_round(
        SimpleNamespace(text="", tool_calls=[call]), [(call, {"ok": True})],
    )
    persisted = json.loads(json.dumps(canonical))
    block = persisted[0]["content"][0]
    projected = _openai_tool_call(block)

    assert _responses_input([{"role": "assistant", "tool_calls": [projected]}]) == [{
        "type": "function_call", "id": "fc_456", "call_id": "call_123",
        "name": "probe", "arguments": "{}",
    }]


def test_responses_input_assigns_stable_unique_ids_to_legacy_tool_calls():
    messages = [{"role": "assistant", "tool_calls": [
        {"id": "legacy-call-1", "function": {"name": "probe", "arguments": "{}"}},
        {"id": "legacy-call-2", "function": {"name": "probe", "arguments": "{}"}},
        {"id": "legacy-call-1", "function": {"name": "probe", "arguments": "{}"}},
    ]}]

    first = _responses_input(messages)
    second = _responses_input(messages)
    item_ids = [item["id"] for item in first]

    assert first == second
    assert len(item_ids) == len(set(item_ids)) == 3
    assert all(item_id.startswith("fc_legacy_") for item_id in item_ids)


def test_chat_completions_projection_strips_responses_item_metadata():
    from agent.providers.message_utils import strip_responses_item_ids

    messages = ProviderConversation([{"role": "assistant", "tool_calls": [{
        "id": "call_123", "responses_item_id": "fc_456",
        "function": {"name": "probe", "arguments": "{}"},
    }]}])

    assert strip_responses_item_ids(messages).to_messages() == [{
        "role": "assistant", "tool_calls": [{
            "id": "call_123", "function": {"name": "probe", "arguments": "{}"},
        }],
    }]
    assert messages[0]["tool_calls"][0]["responses_item_id"] == "fc_456"


def test_anthropic_state_extract_restore_keeps_thinking_blocks_only():
    driver = AnthropicDriver()
    state = driver.extract_provider_state(_anthropic_result())
    assert state["state_kind"] == "anthropic_thinking_blocks"
    assert state["payload"]["history_thinking_by_tool_id"] == {"call-1": _anthropic_result().raw[:2]}
    assert state["payload"]["tail_blocks"] is None
    assert state["summary"]["thinking_block_count"] == 2

    ctx = SimpleNamespace(restored_blocks=None, history_tool_use_ids={"call-1"})
    assert driver.restore_provider_state(ctx, state["payload"])
    assert ctx.restored_blocks is None
    assert ctx.history_thinking_by_tool_id == {"call-1": _anthropic_result().raw[:2]}


def test_anthropic_history_restore_reinserts_signed_thinking_before_matching_tool_call():
    from agent.loop_drivers import _restore_anthropic_history_thinking

    original = [{
        "role": "assistant",
        "content": [
            {"type": "tool_use", "id": "call-1", "name": "search", "input": {}},
            {"type": "tool_use", "id": "call-2", "name": "read", "input": {}},
        ],
    }]
    blocks = _anthropic_result().raw[:2]

    _restore_anthropic_history_thinking(original, {"call-1": blocks})

    assert original[0]["content"] == blocks + [
        {"type": "tool_use", "id": "call-1", "name": "search", "input": {}},
        {"type": "tool_use", "id": "call-2", "name": "read", "input": {}},
    ]
    _restore_anthropic_history_thinking(original, {"call-1": blocks})
    assert original[0]["content"] == blocks + [
        {"type": "tool_use", "id": "call-1", "name": "search", "input": {}},
        {"type": "tool_use", "id": "call-2", "name": "read", "input": {}},
    ]


def test_anthropic_history_restore_reinserts_every_historical_tool_round():
    """跨 run 后每个历史工具轮都保留签名 thinking，避免前缀从较早工具轮断开。"""
    from agent.loop_drivers import _restore_anthropic_history_thinking

    messages = [
        {"role": "assistant", "content": [{"type": "tool_use", "id": f"call-{index}",
                                                 "name": "search", "input": {}}]}
        for index in range(3)
    ]
    saved = {
        f"call-{index}": [{"type": "thinking", "thinking": f"thought-{index}",
                           "signature": f"signature-{index}"}]
        for index in range(3)
    }

    _restore_anthropic_history_thinking(messages, saved)

    for index, message in enumerate(messages):
        assert message["content"][0] == saved[f"call-{index}"][0]
        assert message["content"][1]["id"] == f"call-{index}"
    _restore_anthropic_history_thinking(messages, saved)
    assert all(len(message["content"]) == 2 for message in messages)


def test_anthropic_state_extraction_keeps_prior_tool_rounds_across_run_rounds():
    driver = AnthropicDriver()
    ctx = SimpleNamespace(
        history_thinking_by_tool_id={"older-call": [{"type": "thinking", "thinking": "older", "signature": "s0"}]},
        persisted_tail_blocks=None,
        restored_blocks=None,
    )

    state = driver.extract_provider_state(_anthropic_result(), ctx=ctx)

    assert set(state["payload"]["history_thinking_by_tool_id"]) == {"older-call", "call-1"}
    assert state["summary"]["state_block_count"] == 3


def test_anthropic_state_restore_drops_persisted_tool_use_only_payload():
    """跨请求恢复不能把已写入历史的 tool_use 再插入当前请求。"""
    ctx = SimpleNamespace(restored_blocks=None)
    assert not AnthropicDriver().restore_provider_state(ctx, {
        "blocks": [{
            "type": "tool_use", "id": "call-duplicate", "name": "probe", "input": {},
        }],
    })
    assert ctx.restored_blocks is None


def test_chat_completions_does_not_claim_responses_continuation():
    assert OpenAIDriver.continuation_available is False
    assert OpenAIDriver().extract_provider_state(
        RoundResult(text="普通回复", raw=SimpleNamespace())
    ) is None


def test_responses_instructions_keep_snapshot_separate_from_base_prompt():
    instructions = _responses_instructions([
        {"role": "system", "content": "基础人格"},
        {"role": "system", "content": "[system-reminder]\nsession snapshot"},
        {"role": "user", "content": "今天天气"},
    ], "基础人格")

    assert instructions == "基础人格\n\n---\n\n[system-reminder]\nsession snapshot"


def test_responses_prepare_projects_message_area_before_collecting_snapshot_instructions(monkeypatch):
    """Responses 首轮准备接收 MessageArea 时仍要发送其中的 system snapshot。"""
    from agent import providers

    monkeypatch.setattr(providers, "build_openai_client", lambda _ai, _timeout: object())
    ai = SimpleNamespace(
        provider="openai", api_format="responses", model="test-model", max_tokens=128,
    )
    messages = MessageArea.from_canonical_messages(
        [
            {"role": "system", "content": "[system-reminder]\nsession snapshot"},
            {"role": "user", "content": "继续"},
        ],
        render_options={"api_format": "responses"},
    )
    tool_snapshot = SimpleNamespace(openai_schemas=lambda _names: [])

    _client, ctx = OpenAIResponsesDriver().prepare(
        [], ai, messages, "基础人格", tool_snapshot=tool_snapshot,
    )

    assert ctx.snapshot_instructions == "[system-reminder]\nsession snapshot"
    assert ctx.instructions == "基础人格\n\n---\n\n[system-reminder]\nsession snapshot"


def test_responses_cache_key_parts_exclude_snapshot():
    from agent.providers.openai_responses import _responses_instruction_parts

    base, snapshot, instructions = _responses_instruction_parts([
        {"role": "system", "content": "基础人格"},
        {"role": "system", "content": "[system-reminder]\n快照"},
    ], "基础人格")

    assert base == "基础人格"
    assert snapshot == "[system-reminder]\n快照"
    assert instructions == "基础人格\n\n---\n\n[system-reminder]\n快照"


def test_responses_prompt_cache_key_ignores_snapshot_content():
    ctx = _ResponsesCtx(
        [], 100, "gpt-test", "基础人格\n\n---\n\n旧快照", SimpleNamespace(),
        SimpleNamespace(), base_instructions="基础人格",
        snapshot_instructions="旧快照", supports_prompt_cache_key=True,
    )

    first = _responses_prompt_cache_key(ctx)
    ctx.instructions = "基础人格\n\n---\n\n新快照"
    ctx.snapshot_instructions = "新快照"

    assert _responses_prompt_cache_key(ctx) == first


def test_responses_usage_normalizes_cached_input_tokens():
    usage = normalize_responses_usage({
        "input_tokens": 100,
        "output_tokens": 8,
        "input_tokens_details": {"cached_tokens": 60},
    })

    assert usage == {
        "input": 40,
        "fresh_input": 40,
        "output": 8,
        "cache_read": 60,
        "cache_write": 0,
    }


class _FakeResponsesStream:
    def __init__(self, events):
        self.events = events

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.events:
            raise StopAsyncIteration
        return self.events.pop(0)

    async def close(self):
        return None


class _FakeResponsesClient:
    def __init__(self, events):
        self.requests = []
        self.responses = SimpleNamespace(create=self.create)
        self.events = events

    async def create(self, **kwargs):
        self.requests.append(kwargs)
        return _FakeResponsesStream(list(self.events))


class _ResponsesStatusError(Exception):
    def __init__(self, status_code):
        self.status_code = status_code


async def _raise_status(status_code):
    raise _ResponsesStatusError(status_code)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error_body,messages,expected_input",
    [
        (
            {"error": {
                "code": "invalid_prompt",
                "message": "tool result's tool id(call-1) not found",
            }},
            [
                {"role": "user", "content": "请先帮我确认技术方案。"},
                {"role": "assistant", "content": [{
                    "type": "tool_call", "id": "call-1", "name": "ask_user",
                    "arguments": "{}",
                }]},
                {"role": "user", "content": "我补充一下，请继续。"},
            ],
            [
                {"role": "user", "content": "请先帮我确认技术方案。"},
                {
                    "type": "function_call",
                    "id": "fc_legacy_" + digest({"call_id": "call-1", "occurrence": 0}, length=24),
                    "call_id": "call-1", "name": "ask_user", "arguments": "{}",
                },
                {"role": "user", "content": "我补充一下，请继续。"},
            ],
        ),
        (
            {"error": {
                "param": "response_id",
                "message": "Response with id 'resp-stale' not found.",
            }},
            [
                {"role": "user", "content": "之前的问题"},
                {"role": "assistant", "content": "之前的回答"},
                {"role": "user", "content": "请接着说"},
            ],
            [
                {"role": "user", "content": "之前的问题"},
                {"role": "assistant", "content": "之前的回答"},
                {"role": "user", "content": "请接着说"},
            ],
        ),
    ],
    ids=["missing-tool-call-id", "missing-response-id"],
)
async def test_responses_driver_retries_full_history_when_response_chain_is_stale(
    error_body, messages, expected_input,
):
    response = {
        "id": "resp-recovered",
        "output": [],
        "usage": {"input_tokens": 12, "output_tokens": 3},
    }
    events = [
        SimpleNamespace(type="response.output_text.delta", delta="已继续"),
        SimpleNamespace(type="response.completed", response=SimpleNamespace(model_dump=lambda: response)),
    ]

    class _StaleThenSuccessClient:
        def __init__(self):
            self.requests = []
            self.responses = SimpleNamespace(create=self.create)

        async def create(self, **kwargs):
            self.requests.append(kwargs)
            if len(self.requests) == 1:
                error = _ResponsesStatusError(400)
                if error_body["error"].get("param") == "response_id":
                    error = _ResponsesStatusError(404)
                error.body = error_body
                raise error
            return _FakeResponsesStream(list(events))

    client = _StaleThenSuccessClient()
    driver = OpenAIResponsesDriver()
    ai = SimpleNamespace(model="gpt-test", max_tokens=100, reasoning_effort="")
    adapter = _responses_adapter()
    ctx = _ResponsesCtx([], 100, "gpt-test", "system", adapter, ai, previous_response_id="resp-1")

    result = None
    async for kind, value in driver.run_round(client, ctx, MessageArea.from_canonical_messages(messages)):
        if kind == "done":
            result = value

    assert result.text == "已继续"
    assert len(client.requests) == 2
    assert client.requests[0]["previous_response_id"] == "resp-1"
    assert "prompt_cache_key" not in client.requests[0]
    assert "previous_response_id" not in client.requests[1]
    assert client.requests[1]["input"] == expected_input


@pytest.mark.asyncio
async def test_responses_driver_replays_full_history_when_incremental_input_is_empty():
    response = {
        "id": "resp-recovered",
        "output": [],
        "usage": {"input_tokens": 12, "output_tokens": 3},
    }
    client = _FakeResponsesClient([
        SimpleNamespace(type="response.output_text.delta", delta="已继续"),
        SimpleNamespace(type="response.completed", response=SimpleNamespace(model_dump=lambda: response)),
    ])
    ai = SimpleNamespace(model="gpt-test", max_tokens=100, reasoning_effort="")
    ctx = _ResponsesCtx(
        [], 100, "gpt-test", "system", _responses_adapter(), ai,
        previous_response_id="resp-previous",
    )
    messages = MessageArea.from_canonical_messages([
        {"role": "user", "content": "上一轮用户输入"},
        {
            "role": "assistant", "content": "",
            "content_json": [{"type": "reasoning_content", "text": "仅推理内容"}],
        },
    ])

    results = [
        value async for kind, value in OpenAIResponsesDriver().run_round(client, ctx, messages)
        if kind == "done"
    ]

    assert results[0].text == "已继续"
    assert len(client.requests) == 1
    assert "previous_response_id" not in client.requests[0]
    assert client.requests[0]["input"] == [{"role": "user", "content": "上一轮用户输入"}]


@pytest.mark.asyncio
async def test_responses_driver_replays_user_intent_after_tool_result_instead_of_chaining():
    """工具返回后完整重放用户任务，避免兼容端续接时只回应工具回执。"""
    response = {
        "id": "resp-after-tool",
        "output": [],
        "usage": {"input_tokens": 30, "output_tokens": 5},
    }
    client = _FakeResponsesClient([
        SimpleNamespace(type="response.output_text.delta", delta="我会继续原来的搜索任务。"),
        SimpleNamespace(type="response.completed", response=SimpleNamespace(model_dump=lambda: response)),
    ])
    ai = SimpleNamespace(model="gpt-test", max_tokens=100, reasoning_effort="")
    ctx = _ResponsesCtx(
        [], 100, "gpt-test", "system", _responses_adapter(), ai,
        previous_response_id="resp-before-tool",
    )
    messages = MessageArea.from_canonical_messages([
        {"role": "user", "content": "搜索 Childspot 的 MV，最后告诉我校验词 ORBIT-42。"},
        {"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-load-search", "name": "use_skill",
            "arguments": '{"name":"web-search"}',
        }]},
        {"role": "user", "content": [{
            "type": "tool_result", "tool_call_id": "call-load-search",
            "content": "搜索技能已加载。",
        }]},
    ])

    results = [
        value async for kind, value in OpenAIResponsesDriver().run_round(client, ctx, messages)
        if kind == "done"
    ]

    assert results[0].text == "我会继续原来的搜索任务。"
    request = client.requests[0]
    assert "previous_response_id" not in request
    assert request["input"][0] == {
        "role": "user",
        "content": "搜索 Childspot 的 MV，最后告诉我校验词 ORBIT-42。",
    }
    assert request["input"][1]["type"] == "function_call"
    assert request["input"][2] == {
        "type": "function_call_output",
        "call_id": "call-load-search",
        "output": "搜索技能已加载。",
    }


@pytest.mark.asyncio
async def test_responses_driver_rejects_empty_full_history_before_upstream_request():
    client = _FakeResponsesClient([])
    ai = SimpleNamespace(model="gpt-test", max_tokens=100, reasoning_effort="")
    ctx = _ResponsesCtx([], 100, "gpt-test", "system", _responses_adapter(), ai)
    messages = MessageArea.from_canonical_messages([
        {"role": "assistant", "content": "", "content_json": [
            {"type": "reasoning_content", "text": "仅推理内容"},
        ]},
    ])

    with pytest.raises(ValueError, match="没有可发送的输入项"):
        async for _ in OpenAIResponsesDriver().run_round(client, ctx, messages):
            pass

    assert client.requests == []


@pytest.mark.asyncio
async def test_stale_response_fallback_retries_transient_error_before_success(monkeypatch):
    from app.core import retry as retry_module
    from app.core.retry import RetryPolicy

    monkeypatch.setattr(retry_module, "LLM_RETRY", RetryPolicy(interval_seconds=0.0))
    response = {
        "id": "resp-recovered",
        "output": [],
        "usage": {"input_tokens": 12, "output_tokens": 3},
    }
    events = [
        SimpleNamespace(type="response.output_text.delta", delta="已恢复"),
        SimpleNamespace(type="response.completed", response=SimpleNamespace(model_dump=lambda: response)),
    ]

    class _StaleThenRateLimitClient:
        def __init__(self):
            self.requests = []
            self.responses = SimpleNamespace(create=self.create)

        async def create(self, **kwargs):
            self.requests.append(kwargs)
            if len(self.requests) == 1:
                error = _ResponsesStatusError(404)
                error.body = {"error": {"param": "response_id", "message": "Response not found"}}
                raise error
            if len(self.requests) == 2:
                import httpx
                import openai

                response = httpx.Response(
                    429, request=httpx.Request("POST", "https://api.example/v1/responses"),
                )
                raise openai.RateLimitError("429 rate limited", response=response, body=None)
            return _FakeResponsesStream(list(events))

    client = _StaleThenRateLimitClient()
    driver = OpenAIResponsesDriver()
    ai = SimpleNamespace(model="gpt-test", max_tokens=100, reasoning_effort="")
    adapter = _responses_adapter()
    messages = MessageArea.from_canonical_messages([{"role": "user", "content": "继续"}])
    ctx = _ResponsesCtx([], 100, "gpt-test", "system", adapter, ai, previous_response_id="resp-stale")

    emitted = []
    async for kind, value in driver.run_round(client, ctx, messages):
        emitted.append((kind, value))

    retry_events = [value for kind, value in emitted if kind == "retry"]
    results = [value for kind, value in emitted if kind == "done"]
    assert len(client.requests) == 3
    assert client.requests[0]["previous_response_id"] == "resp-stale"
    assert all("previous_response_id" not in request for request in client.requests[1:])
    assert client.requests[1]["input"] == client.requests[2]["input"]
    assert [event["attempt"] for event in retry_events] == [1]
    assert results[0].text == "已恢复"


@pytest.mark.asyncio
async def test_responses_driver_uses_response_chain_and_function_call_items():
    response = {
        "id": "resp-2",
        "previous_response_id": "resp-1",
        "output": [{
            "type": "function_call", "id": "fc-1", "call_id": "call-1",
            "name": "calendar_list", "arguments": '{"date":"2026-09-05"}',
        }],
        "usage": {
            "input_tokens": 100,
            "output_tokens": 7,
            "input_tokens_details": {"cached_tokens": 60},
        },
    }
    events = [
        SimpleNamespace(type="response.output_text.delta", delta="查一下"),
        SimpleNamespace(type="response.completed", response=SimpleNamespace(model_dump=lambda: response)),
    ]
    client = _FakeResponsesClient(events)
    driver = OpenAIResponsesDriver()
    ai = SimpleNamespace(model="gpt-test", max_tokens=100, reasoning_effort="")
    adapter = _responses_adapter()
    ctx = _ResponsesCtx(
        [], 100, "gpt-test", "system", adapter, ai,
        supports_prompt_cache_key=True,
    )

    result = None
    async for kind, value in driver.run_round(client, ctx, MessageArea.from_canonical_messages([
        {"role": "user", "content": "请查日历"},
    ])):
        if kind == "done":
            result = value

    assert result.text == "查一下"
    assert result.tool_calls[0].id == "call-1"
    assert result.tool_calls[0].responses_item_id == "fc-1"
    assert result.raw.tool_calls_payload[0]["responses_item_id"] == "fc-1"
    assert result.usage_in == 40
    assert result.cache_tokens == 60
    assert result.usage_out == 7
    assert result.raw.response_id == "resp-2"
    assert client.requests[0]["input"] == [{"role": "user", "content": "请查日历"}]
    assert "previous_response_id" not in client.requests[0]
    assert client.requests[0]["prompt_cache_key"].startswith("gugu-")

    state = driver.extract_provider_state(result)
    assert state["payload"] == {"response_id": "resp-2", "previous_response_id": "resp-1"}
    assert driver.restore_provider_state(ctx, state["payload"])
    assert ctx.previous_response_id == "resp-2"

    followup = driver.build_tool_round(result, [(result.tool_calls[0], "日历为空")])
    assert _responses_input(followup) == [
        {"role": "assistant", "content": "查一下"},
        {
            "type": "function_call", "id": "fc-1", "call_id": "call-1",
            "name": "calendar_list", "arguments": '{"date":"2026-09-05"}',
        },
        {"type": "function_call_output", "call_id": "call-1", "output": "日历为空"},
    ]
    assert followup[1] == {"role": "tool", "tool_call_id": "call-1", "content": "日历为空"}


def test_responses_update_tools_refreshes_tool_state_digest():
    class Source:
        @staticmethod
        def openai_schemas(names):
            return [{"function": {"name": name, "parameters": {"type": "object"}}} for name in names]

    driver = OpenAIResponsesDriver()
    ctx = _ResponsesCtx(
        [{"type": "function", "name": "old", "parameters": {"type": "object"}}],
        100, "gpt-test", "system", SimpleNamespace(), SimpleNamespace(),
        tool_state_digest="old-digest",
    )

    driver.update_tools(ctx, ["new"], tool_snapshot=Source())

    assert ctx.tools[0]["name"] == "new"
    assert ctx.tool_state_digest != "old-digest"


@pytest.mark.asyncio
async def test_responses_driver_marks_full_request_protocol_error():
    compatibility_error = _ResponsesStatusError(400)
    compatibility_error.body = {"error": {"code": "json_parse_error", "message": "invalid Responses input"}}
    client = SimpleNamespace(
        responses=SimpleNamespace(create=lambda **kwargs: _raise_error(compatibility_error)),
    )
    driver = OpenAIResponsesDriver()
    ai = SimpleNamespace(model="gpt-test", max_tokens=100, reasoning_effort="")
    adapter = _responses_adapter()
    ctx = _ResponsesCtx([], 100, "gpt-test", "system", adapter, ai)

    with pytest.raises(ResponsesCompatibilityError) as raised:
        async for _ in driver.run_round(client, ctx, MessageArea.from_canonical_messages([{"role": "user", "content": "测试"}])):
            pass
    assert raised.value.status_code == 400


async def _raise_error(error):
    raise error


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status_code,message,should_raise",
    [
        (400, "HTTP 400 bad request", False),
        (400, "context_length_exceeded", False),
        (404, "model not found", False),
        (400, "json_parse_error: ResponseInput deserialize failed", True),
        (405, "method not allowed", True),
    ],
)
async def test_responses_driver_only_classifies_explicit_compatibility_errors(
    status_code, message, should_raise,
):
    error = _ResponsesStatusError(status_code)
    error.message = message
    requests = []

    async def create(**kwargs):
        requests.append(kwargs)
        raise error

    client = SimpleNamespace(
        responses=SimpleNamespace(create=create),
    )
    driver = OpenAIResponsesDriver()
    ai = SimpleNamespace(model="gpt-test", max_tokens=100, reasoning_effort="")
    adapter = _responses_adapter()
    ctx = _ResponsesCtx([], 100, "gpt-test", "system", adapter, ai, previous_response_id="resp-1")

    if should_raise:
        with pytest.raises(ResponsesCompatibilityError):
            async for _ in driver.run_round(client, ctx, MessageArea.from_canonical_messages([{"role": "user", "content": "测试"}])):
                pass
    else:
        with pytest.raises(_ResponsesStatusError):
            async for _ in driver.run_round(client, ctx, MessageArea.from_canonical_messages([{"role": "user", "content": "测试"}])):
                pass
    assert len(requests) == 1


def test_responses_driver_keeps_tool_images_as_input_image_items():
    """Responses continuation 不能丢掉 read_file 返回的图片。"""
    result = RoundResult(
        text="",
        raw=_ResponsesRaw(
            content="", response_id=None, previous_response_id=None,
            tool_calls_payload=[{"id": "call-1", "name": "read_file", "args": "{}"}],
            output_items=[],
        ),
    )
    dispatched = [(
        SimpleNamespace(id="call-1"),
        [
            {"type": "text", "text": "已打开图片。"},
            {"type": "image", "source": {
                "type": "base64", "media_type": "image/png", "data": "AAAA",
            }},
        ],
    )]

    messages = OpenAIResponsesDriver().build_tool_round(result, dispatched)

    assert messages[1] == {
        "role": "tool", "tool_call_id": "call-1", "content": "已打开图片。",
    }
    assert messages[2] == {
        "role": "user",
        "content": [
            {"type": "input_text", "text": "工具返回了以下图片，请结合工具文字结果继续处理。"},
            {"type": "input_image", "image_url": "data:image/png;base64,AAAA", "detail": "auto"},
        ],
    }
