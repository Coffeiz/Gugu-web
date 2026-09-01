"""流式出站与 session gate 的关键回归测试。"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from pathlib import Path
from inspect import signature

from fastapi.dependencies.utils import get_dependant

import pytest

from agent.im.replies import send_qq_stream_by_round
from agent.interactions.events import ROUND_END
from agent.models import AgentResponse


class _FakeStream:
    def __init__(self, fail_finish: bool = False):
        self.fail_finish = fail_finish
        self.sent = False
        self.parts: list[str] = []

    def push(self, text: str) -> None:
        self.parts.append(text)

    async def finish(self, text: str) -> None:
        if self.fail_finish:
            raise RuntimeError("QQ transport failed")
        self.sent = True

    def has_sent(self) -> bool:
        return self.sent


def test_collect_and_stream_share_im_preparation_rules():
    from agent import runner
    from agent.models import AgentRequest

    source = Path(runner.__file__).read_text(encoding="utf-8")
    assert source.count("_snapshot_im_memory(") >= 3
    assert source.count("_proactive_lead_for(req, history)") == 2
    assert source.count("chat_attach.should_transcribe_audio(model_cfg)") == 2

    private_req = AgentRequest(
        message="hello", user_id="user", user_name="member", source="qq",
        platform_user_id="platform-user",
    )
    snapshot, saved_memory = runner._snapshot_im_memory(
        "base", {"platform_user": {"summary": "stable preference"}}, private_req,
        restricted=True,
    )
    assert "当前发言人的平台记忆" in snapshot
    assert saved_memory == {"platform_user": {"summary": "stable preference"}}

    group_req = AgentRequest(
        message="hello", user_id="user", user_name="member", source="qq",
        chat_id="group",
    )
    assert runner._proactive_lead_for(group_req, [SimpleNamespace(role="assistant", content="lead")]) == "lead"
    assert runner._proactive_lead_for(private_req, [SimpleNamespace(role="assistant", content="lead")]) == ""


def test_long_lived_stream_routes_do_not_hold_dependency_sessions():
    from app.api.v1.agent import chat, resume_stream
    from app.api.v1.terminals import stream_terminal_events, terminal_websocket
    from app.db.session import get_db

    def dependency_calls(callable_):
        root = get_dependant(path="/test", call=callable_)
        result = []

        def walk(node):
            if node.call is not None:
                result.append(node.call)
            for child in node.dependencies:
                walk(child)

        walk(root)
        return result

    for endpoint in (chat, resume_stream, stream_terminal_events, terminal_websocket):
        assert get_db not in dependency_calls(endpoint), endpoint.__name__

    assert "db" not in signature(resume_stream).parameters
    assert "db" not in signature(stream_terminal_events).parameters

    session_source = Path(__file__).parents[1].joinpath("app/db/session.py").read_text(encoding="utf-8")
    assert "await asyncio.shield(session.close())" in session_source


@pytest.mark.asyncio
async def test_terminal_websocket_setup_failure_cleans_pty_resources():
    from app.api.v1.terminals import _reject_terminal_websocket_setup

    class _Manager:
        def __init__(self):
            self.actions = []

        async def unsubscribe(self, terminal_id, queue):
            self.actions.append(("unsubscribe", terminal_id, queue))

        async def detach(self, terminal_id):
            self.actions.append(("detach", terminal_id))

    class _WebSocket:
        async def close(self, **_kwargs):
            raise RuntimeError("already disconnected")

    manager = _Manager()
    await _reject_terminal_websocket_setup(
        _WebSocket(), 403, manager, "term-setup-race", "queue", True,
    )

    assert manager.actions == [
        ("unsubscribe", "term-setup-race", "queue"),
        ("detach", "term-setup-race"),
    ]


@pytest.mark.asyncio
async def test_terminal_websocket_cleanup_survives_task_cancellation_and_partial_failure():
    from app.api.v1.terminals import _cleanup_terminal_websocket_resources

    class _Manager:
        def __init__(self):
            self.actions = []

        async def unsubscribe(self, terminal_id, queue):
            self.actions.append(("unsubscribe", terminal_id, queue))
            raise ValueError("subscription already gone")

        async def detach(self, terminal_id):
            self.actions.append(("detach", terminal_id))

    manager = _Manager()

    async def cancelled_setup():
        try:
            await asyncio.sleep(60)
        except BaseException:
            await _cleanup_terminal_websocket_resources(manager, "term-cancel", "queue", True)
            raise

    task = asyncio.create_task(cancelled_setup())
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert manager.actions == [
        ("unsubscribe", "term-cancel", "queue"),
        ("detach", "term-cancel"),
    ]


@pytest.mark.asyncio
async def test_qq_stream_drains_agent_after_transport_failure(monkeypatch):
    streams: list[_FakeStream] = []

    def make_stream(*_args, **_kwargs):
        stream = _FakeStream(fail_finish=bool(streams))
        streams.append(stream)
        return stream

    import agent.gateway.qq as qq
    monkeypatch.setattr(qq, "create_private_text_stream", make_stream)

    consumed: list[str] = []

    async def token_iter():
        consumed.append("round-1")
        yield ("token", "第一轮")
        yield (ROUND_END, "第一轮")
        consumed.append("round-2")
        yield ("token", "第二轮")
        yield ("final", AgentResponse(text="收尾", session_id=7))
        consumed.append("done")

    sent, response, last_text = await send_qq_stream_by_round(
        {"platform_user_id": "user", "channel_id": "channel"}, token_iter()
    )

    assert sent is False
    assert response.session_id == 7
    assert last_text == "收尾"
    assert consumed == ["round-1", "round-2", "done"]


@pytest.mark.asyncio
async def test_run_stream_waits_for_baseline_after_final(monkeypatch):
    import agent.context.compress_conv as compress_conv
    from agent import runner

    events: list[str] = []

    class _Gate:
        async def __aenter__(self):
            events.append("enter")

        async def __aexit__(self, *_args):
            events.append("exit")

    async def fake_unlocked(*_args, **_kwargs):
        yield ("final", AgentResponse(text="done", session_id=11))
        events.append("generator-finished")

    async def fake_wait(session_id):
        events.append(f"baseline:{session_id}")

    monkeypatch.setattr(compress_conv, "session_run_gate", lambda _req: _Gate())
    monkeypatch.setattr(compress_conv, "wait_for_baseline_update", fake_wait)
    monkeypatch.setattr(runner, "_run_stream_unlocked", fake_unlocked)

    items = [item async for item in runner.run_stream(SimpleNamespace(session_id=None))]

    assert items[0][0] == "final"
    assert events == ["enter", "generator-finished", "baseline:11", "exit"]


@pytest.mark.asyncio
async def test_feishu_fallback_drains_agent_after_final(monkeypatch):
    from agent.gateway import feishu

    monkeypatch.setattr(feishu, "_creds_by_id", lambda _channel_id: _async_value(("app", "secret")))
    monkeypatch.setattr(feishu, "_do_create_card", lambda *_args: _async_value(None))
    sent_texts: list[str] = []

    async def fake_send_text(_receive_id, text, _channel_id):
        sent_texts.append(text)
        return True

    monkeypatch.setattr(feishu, "send_text", fake_send_text)
    consumed: list[str] = []

    async def token_iter():
        yield ("final", AgentResponse(text="最终回复", session_id=12))
        consumed.append("after-final")

    ok, response = await feishu.send_text_stream("receive", token_iter(), channel_id="channel")

    assert ok is True
    assert response.session_id == 12
    assert consumed == ["after-final"]
    assert sent_texts == ["最终回复"]


async def _async_value(value):
    return value
