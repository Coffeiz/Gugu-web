import json

import pytest

from app.api.v1 import live


def _event(**overrides):
    value = {
        "protocol_version": "live-event-v1",
        "event_id": "evt-1",
        "type": "resource.changed",
        "resource": "files",
        "operation": "update",
        "revision": 3,
        "created_at": "2026-08-28T00:00:00+00:00",
    }
    value.update(overrides)
    return value


def test_serialize_live_message_accepts_canonical_event_and_notification():
    frame = live._serialize_message(json.dumps(_event()))
    assert frame.startswith("data: ")
    assert json.loads(frame.removeprefix("data: ").strip()) == _event()

    notification = live._serialize_message(json.dumps({"notification": {"id": 1}}))
    assert notification is not None


def test_serialize_live_message_rejects_non_business_payloads():
    assert live._serialize_message("not-json") is None
    assert live._serialize_message(json.dumps({"resource": "files"})) is None
    assert live._serialize_message(json.dumps(_event(resource="unknown"))) is None


class _Request:
    def __init__(self):
        self.disconnected = False

    async def is_disconnected(self):
        return self.disconnected


class _PubSub:
    def __init__(self, request):
        self.request = request
        self.subscribed = None
        self.unsubscribed = None
        self.closed = False
        self.messages = [{"data": json.dumps(_event())}]

    async def subscribe(self, *channels):
        self.subscribed = channels

    async def get_message(self, **_kwargs):
        if self.messages:
            return self.messages.pop(0)
        self.request.disconnected = True
        return None

    async def unsubscribe(self, *channels):
        self.unsubscribed = channels

    async def aclose(self):
        self.closed = True


class _Redis:
    def __init__(self, pubsub):
        self.pubsub_instance = pubsub

    def pubsub(self):
        return self.pubsub_instance


@pytest.mark.asyncio
async def test_event_stream_uses_user_and_broadcast_channels_and_closes_pubsub(monkeypatch):
    request = _Request()
    pubsub = _PubSub(request)
    monkeypatch.setattr(live, "get_redis", lambda: _Redis(pubsub))

    frames = [frame async for frame in live._event_stream(request, "user-1")]

    assert frames[0] == ": connected\n\n"
    assert frames[1].startswith("data: ")
    assert pubsub.subscribed == ("events:user-1", live.BROADCAST_CHANNEL)
    assert pubsub.unsubscribed == pubsub.subscribed
    assert pubsub.closed is True
