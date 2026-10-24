"""锁定 Web 续看 SSE 的公开帧顺序与空闲收口行为。"""

import json

import pytest

from agent.gateway import web
from agent.llm import genstream


def _event_from_sse(line: str) -> dict:
    assert line.startswith("data: ")
    assert line.endswith("\n\n")
    return json.loads(line[6:-2])


@pytest.mark.asyncio
async def test_resume_replays_timeline_in_order_before_live_events(monkeypatch):
    pubsub = object()
    timeline = [
        {"type": "display_event", "item": {"eventId": "a", "kind": "assistant", "text": "先说"}},
        {"type": "display_event", "item": {"eventId": "b", "kind": "tool", "toolStatus": "success"}},
        {"type": "display_event", "item": {"eventId": "c", "kind": "assistant", "text": "后说"}},
    ]

    async def open_subscription(session_id):
        assert session_id == 701
        return pubsub

    async def snapshot(session_id):
        assert session_id == 701
        return {"done": False, "timeline": timeline}

    async def subscribe(session_id, *, pubsub):
        assert session_id == 701
        assert pubsub is subscription
        yield 'data: {"type":"display_event","item":{"eventId":"d","text":"实时尾部"}}\n\n'
        yield 'data: {"type":"done","run_id":"run-a"}\n\n'

    subscription = pubsub
    monkeypatch.setattr(genstream, "open_subscription", open_subscription)
    monkeypatch.setattr(genstream, "snapshot", snapshot)
    monkeypatch.setattr(genstream, "subscribe", subscribe)

    frames = [_event_from_sse(line) async for line in web.resume(701)]

    assert frames == [
        *timeline,
        {"type": "display_event", "item": {"eventId": "d", "text": "实时尾部"}},
        {"type": "done", "run_id": "run-a"},
    ]


@pytest.mark.asyncio
async def test_resume_without_active_snapshot_emits_idle_done(monkeypatch):
    pubsub = object()
    closed = []

    async def open_subscription(session_id):
        assert session_id == 702
        return pubsub

    async def snapshot(session_id):
        assert session_id == 702
        return None

    async def close_subscription(session_id, subscription):
        closed.append((session_id, subscription))

    monkeypatch.setattr(genstream, "open_subscription", open_subscription)
    monkeypatch.setattr(genstream, "snapshot", snapshot)
    monkeypatch.setattr(genstream, "close_subscription", close_subscription)

    frames = [line async for line in web.resume(702)]

    assert frames == ['data: {"type": "done", "idle": true}\n\n']
    assert closed == [(702, pubsub)]
