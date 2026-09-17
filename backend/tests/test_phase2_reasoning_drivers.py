from types import SimpleNamespace

import pytest

from agent.loop_drivers import (
    AnthropicDriver,
    OpenAIDriver,
    RoundResult,
    NormalizedToolCall,
)
from agent.providers.openai_responses import (
    OpenAIResponsesDriver,
    ResponsesCompatibilityError,
    _ResponsesCtx,
    _ResponsesRaw,
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


class _ResponsesStatusError(Exception):
    def __init__(self, status_code):
        self.status_code = status_code


async def _raise_status(status_code):
    raise _ResponsesStatusError(status_code)


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


@pytest.mark.asyncio
async def test_responses_driver_marks_full_request_protocol_error():
    compatibility_error = _ResponsesStatusError(400)
    compatibility_error.body = {"error": {"code": "json_parse_error", "message": "invalid Responses input"}}
    client = SimpleNamespace(
        responses=SimpleNamespace(create=lambda **kwargs: _raise_error(compatibility_error)),
    )
    driver = OpenAIResponsesDriver()
    ai = SimpleNamespace(model="gpt-test", max_tokens=100, reasoning_effort="")
    adapter = SimpleNamespace(render_history=lambda messages: list(messages))
    ctx = _ResponsesCtx([], 100, "gpt-test", "system", adapter, ai)

    with pytest.raises(ResponsesCompatibilityError) as raised:
        async for _ in driver.run_round(client, ctx, [{"role": "user", "content": "测试"}]):
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
    client = SimpleNamespace(
        responses=SimpleNamespace(create=lambda **kwargs: _raise_error(error)),
    )
    driver = OpenAIResponsesDriver()
    ai = SimpleNamespace(model="gpt-test", max_tokens=100, reasoning_effort="")
    adapter = SimpleNamespace(render_history=lambda messages: list(messages))
    ctx = _ResponsesCtx([], 100, "gpt-test", "system", adapter, ai)

    if should_raise:
        with pytest.raises(ResponsesCompatibilityError):
            async for _ in driver.run_round(client, ctx, [{"role": "user", "content": "测试"}]):
                pass
    else:
        with pytest.raises(_ResponsesStatusError):
            async for _ in driver.run_round(client, ctx, [{"role": "user", "content": "测试"}]):
                pass


def test_responses_driver_keeps_tool_images_as_input_image_items():
    """Responses continuation 不能丢掉 read_file/inspect_images 返回的图片。"""
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
