"""真实 SDK 坏流回归：恢复正文、错误归因及工具已执行后的单次恢复。"""
from copy import deepcopy
from types import SimpleNamespace
import json

import anthropic
from anthropic.lib.streaming._messages import AsyncMessageStream
from anthropic.types import (
    Message, RawContentBlockDeltaEvent, RawContentBlockStartEvent,
    RawContentBlockStopEvent, RawMessageStartEvent, RawMessageStopEvent,
    TextBlock, TextDelta, ToolUseBlock, Usage,
)
import pytest

from agent.errors import describe_llm_error
from agent.loop.provider import stream_round
from agent.providers import adapter_for
from agent.providers.errors import anthropic_stream_protocol_details


def _message(content):
    return Message(id="synthetic-message", type="message", role="assistant", model="fake",
                   content=content, stop_reason="end_turn", stop_sequence=None,
                   usage=Usage(input_tokens=10, output_tokens=7))


def _start():
    return RawMessageStartEvent(type="message_start", message=_message([]))


def _bad_stream(*, after_text=False, delta=False):
    events = [_start()]
    if after_text:
        events.extend([
            RawContentBlockStartEvent(type="content_block_start", index=0,
                                      content_block=TextBlock(type="text", text="")),
            RawContentBlockDeltaEvent(type="content_block_delta", index=0,
                                      delta=TextDelta(type="text_delta", text="已输出")),
        ])
    index = 1 if after_text else 0
    events.append(
        RawContentBlockDeltaEvent(type="content_block_delta", index=index,
                                  delta=TextDelta(type="text_delta", text="私有正文"))
        if delta else RawContentBlockStopEvent(type="content_block_stop", index=index)
    )
    return events


class _Raw:
    def __init__(self, events):
        self.events = events
        self.closed = False

    async def __aiter__(self):
        for event in self.events:
            yield event

    async def close(self):
        self.closed = True


class _Messages:
    def __init__(self, streams, recovery=None, failure=None):
        self.streams = list(streams)
        self.recovery = recovery or _message([TextBlock(type="text", text="恢复完成")])
        self.failure = failure
        self.stream_requests = []
        self.create_requests = []
        self.raw_streams = []

    def stream(self, **kwargs):
        self.stream_requests.append(deepcopy(kwargs))
        raw = _Raw(self.streams.pop(0))
        self.raw_streams.append(raw)
        return AsyncMessageStream(raw, output_format=anthropic.NOT_GIVEN)

    async def create(self, **kwargs):
        self.create_requests.append(deepcopy(kwargs))
        if self.failure is not None:
            raise self.failure
        return self.recovery


@pytest.mark.parametrize("delta", [False, True])
async def test_missing_block_recovers_once_with_identical_request_and_visible_text(delta):
    messages = _Messages([_bad_stream(delta=delta)])
    kwargs = {"model":"fake", "max_tokens":8000, "system":"合成人格",
              "messages":[{"role":"user", "content":"合成请求"}], "tools":[]}
    original = deepcopy(kwargs)
    events = [event async for event in stream_round(
        SimpleNamespace(messages=messages), kwargs, adapter_for(SimpleNamespace(provider="minimax")),
    )]
    assert events[0] == ("token", "恢复完成")
    assert events[-1] == ("final", messages.recovery)
    assert messages.stream_requests == [original]
    assert messages.create_requests == [original]
    assert kwargs == original
    assert all(raw.closed for raw in messages.raw_streams)


async def test_recovery_failure_is_not_replayed_and_reports_protocol_diagnostic(monkeypatch):
    import agent.errors as errors
    captured = []
    monkeypatch.setattr(errors, "diag_log", lambda where, error: captured.append((where,error)))
    failure = RuntimeError("私有上游细节")
    messages = _Messages([_bad_stream()], failure=failure)
    with pytest.raises(RuntimeError) as caught:
        async for _event in stream_round(SimpleNamespace(messages=messages), {},
                                         adapter_for(SimpleNamespace(provider="minimax"))):
            pass
    assert caught.value is failure
    assert len(messages.stream_requests) == len(messages.create_requests) == 1
    details = anthropic_stream_protocol_details(caught.value)
    assert details == {"event_type":"content_block_stop", "index":0, "block_count":0}
    info = describe_llm_error(caught.value)
    assert info.code == "provider_stream_error"
    assert info.message_params["diagnostic_id"]
    assert "私有上游细节" not in json.dumps(info.as_event(), ensure_ascii=False)
    assert captured[0][1] is failure


async def test_missing_block_after_visible_text_does_not_replay():
    messages = _Messages([_bad_stream(after_text=True)])
    tokens = []
    with pytest.raises(IndexError) as caught:
        async for kind, value in stream_round(SimpleNamespace(messages=messages), {},
                                              adapter_for(SimpleNamespace(provider="minimax"))):
            if kind == "token":
                tokens.append(value)
    assert tokens == ["已输出"]
    assert len(messages.stream_requests) == 1
    assert messages.create_requests == []
    assert anthropic_stream_protocol_details(caught.value)["block_count"] == 1
    assert anthropic_stream_protocol_details(IndexError("应用内部错误")) is None


@pytest.mark.parametrize("recover_tool_call", [False, True])
async def test_tool_round_recovery_delivers_text_and_executes_each_tool_once(monkeypatch, recover_tool_call):
    import agent.core as core
    from agent import providers
    from agent.context.assembly import MessageArea

    call = ToolUseBlock(type="tool_use", id="synthetic-tool", name="note_create",
                        input={"title":"合成笔记", "blocks":[]})
    tool_stream = [_start(), RawContentBlockStartEvent(type="content_block_start", index=0, content_block=call),
                   RawContentBlockStopEvent(type="content_block_stop", index=0),
                   RawMessageStopEvent(type="message_stop")]
    text_stream = [_start(), RawContentBlockStartEvent(type="content_block_start", index=0,
                                                    content_block=TextBlock(type="text", text="")),
                   RawContentBlockDeltaEvent(type="content_block_delta", index=0,
                                             delta=TextDelta(type="text_delta", text="笔记保存完成")),
                   RawContentBlockStopEvent(type="content_block_stop", index=0),
                   RawMessageStopEvent(type="message_stop")]
    # 分别保护已执行工具后的正文恢复，以及恢复出的新工具调用只执行一次。
    messages = _Messages(
        [_bad_stream(), text_stream] if recover_tool_call else [tool_stream, _bad_stream()],
        recovery=_message([call] if recover_tool_call else [TextBlock(type="text", text="笔记保存完成")]),
    )
    async def close():
        pass
    client = SimpleNamespace(messages=messages, close=close)
    monkeypatch.setattr(providers, "build_anthropic_client", lambda *_args: client)
    dispatched = []
    async def dispatch(_user, target, arguments, **_kwargs):
        dispatched.append(target)
        return json.dumps({"status":"success", "node_id":7}), None
    monkeypatch.setattr(core, "_dispatch_in_session", dispatch)
    ai = SimpleNamespace(model="fake", provider="minimax", api_key="synthetic", base_url="http://local",
                         max_tokens=8000, thinking="disabled", context_tokens=1000000)
    runner = core.LLMRunner(tool_names=["note_create"], settings=SimpleNamespace(ai=ai))
    area = MessageArea.from_canonical_messages([{"role":"user", "content":"记录一条合成笔记"}])
    events = []
    async for chunk in runner._run_anthropic("synthetic-user", "合成人格", area, ai):
        for line in chunk.splitlines():
            if line.startswith("data: ") and line[6:] != "[DONE]":
                events.append(json.loads(line[6:]))
    assert dispatched == ["note_create"]
    assert len(messages.stream_requests) == 2
    assert messages.create_requests == [messages.stream_requests[0 if recover_tool_call else -1]]
    assert "".join(event["content"] for event in events if event["type"] == "token") == "笔记保存完成"
    assert not [event for event in events if event["type"] == "error"]
    assert len([event for event in events if event["type"] == "tool_done"]) == 1
