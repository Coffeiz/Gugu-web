from types import SimpleNamespace

import pytest

from agent.loop_drivers import (
    AnthropicDriver,
    OpenAIDriver,
    OpenAIResponsesDriver,
    RoundResult,
    NormalizedToolCall,
    _ResponsesCtx,
)


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


def test_anthropic_state_extract_restore_is_exact_and_provider_only():
    driver = AnthropicDriver()
    state = driver.extract_provider_state(_anthropic_result())
    assert state["state_kind"] == "anthropic_thinking_blocks"
    assert state["payload"]["blocks"] == _anthropic_result().raw
    assert state["summary"]["thinking_block_count"] == 2

    ctx = SimpleNamespace(restored_blocks=None)
    assert driver.restore_provider_state(ctx, state["payload"])
    assert ctx.restored_blocks == _anthropic_result().raw


def test_chat_completions_does_not_claim_responses_continuation():
    assert OpenAIDriver.continuation_available is False
    assert OpenAIDriver().extract_provider_state(
        RoundResult(text="普通回复", raw=SimpleNamespace())
    ) is None


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


@pytest.mark.asyncio
async def test_responses_driver_uses_response_chain_and_function_call_items():
    response = {
        "id": "resp-2",
        "previous_response_id": "resp-1",
        "output": [{
            "type": "function_call", "id": "fc-1", "call_id": "call-1",
            "name": "calendar_list", "arguments": '{"date":"2026-09-05"}',
        }],
        "usage": {"input_tokens": 12, "output_tokens": 7},
    }
    events = [
        SimpleNamespace(type="response.output_text.delta", delta="查一下"),
        SimpleNamespace(type="response.completed", response=SimpleNamespace(model_dump=lambda: response)),
    ]
    client = _FakeResponsesClient(events)
    driver = OpenAIResponsesDriver()
    ai = SimpleNamespace(model="gpt-test", max_tokens=100, reasoning_effort="")
    adapter = SimpleNamespace(render_history=lambda messages: list(messages))
    ctx = _ResponsesCtx([], 100, "gpt-test", "system", adapter, ai)

    result = None
    async for kind, value in driver.run_round(client, ctx, [
        {"role": "user", "content": "请查日历"},
    ]):
        if kind == "done":
            result = value

    assert result.text == "查一下"
    assert result.tool_calls[0].id == "call-1"
    assert result.raw.response_id == "resp-2"
    assert client.requests[0]["input"] == [{"role": "user", "content": "请查日历"}]
    assert "previous_response_id" not in client.requests[0]

    state = driver.extract_provider_state(result)
    assert state["payload"] == {"response_id": "resp-2", "previous_response_id": "resp-1"}
    assert driver.restore_provider_state(ctx, state["payload"])
    assert ctx.previous_response_id == "resp-2"

    followup = driver.build_tool_round(result, [(result.tool_calls[0], "日历为空")])
    assert followup[1] == {"role": "tool", "tool_call_id": "call-1", "content": "日历为空"}
