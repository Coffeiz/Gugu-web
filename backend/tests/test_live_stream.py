import json

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError

from app.api.v1 import live
from app.core import events


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


def test_serialize_live_message_present_payload_allowlist():
    ok = {"present": {"file_id": 12, "name": "demo", "ext": "png"}}
    frame = live._serialize_message(json.dumps(ok))
    assert frame is not None
    assert json.loads(frame.removeprefix("data: ").strip()) == ok

    # file_id 非整数 / 缺失 / 布尔（bool 是 int 子类）都丢弃
    assert live._serialize_message(json.dumps({"present": {"file_id": "12"}})) is None
    assert live._serialize_message(json.dumps({"present": {"name": "demo"}})) is None
    assert live._serialize_message(json.dumps({"present": {"file_id": True}})) is None
    assert live._serialize_message(json.dumps({"present": "demo.png"})) is None


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


class _DisconnectingPubSub(_PubSub):
    async def get_message(self, **_kwargs):
        raise RedisConnectionError("Connection closed by server")


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


@pytest.mark.asyncio
async def test_event_stream_stops_after_account_is_suspended(monkeypatch):
    request = _Request()
    pubsub = _PubSub(request)
    monkeypatch.setattr(live, "get_redis", lambda: _Redis(pubsub))

    async def inactive(_user_id):
        return False

    frames = [frame async for frame in live._event_stream(request, "user-1", active_check=inactive)]
    assert frames == [": connected\n\n", "event: account_suspended\ndata: {\"message\":\"账号暂时不可用\"}\n\n"]
    assert pubsub.closed is True


@pytest.mark.asyncio
async def test_event_stream_ends_cleanly_when_redis_disconnects(monkeypatch):
    request = _Request()
    pubsub = _DisconnectingPubSub(request)
    monkeypatch.setattr(live, "get_redis", lambda: _Redis(pubsub))

    frames = [frame async for frame in live._event_stream(request, "user-1")]

    assert frames == [": connected\n\n", ": live connection reset; client will reconnect\n\n"]
    assert pubsub.closed is True


@pytest.mark.asyncio
async def test_publish_uses_resource_revision_not_global_revision(monkeypatch):
    class Redis:
        def __init__(self):
            self.keys = []
            self.published = []

        async def incr(self, key):
            self.keys.append(key)
            return 1

        async def expire(self, *_args):
            return True

        async def publish(self, channel, value):
            self.published.append((channel, json.loads(value)))

    redis = Redis()
    monkeypatch.setattr(events, "get_redis", lambda: redis)
    await events.publish("user-1", "projects", operation="update", entity_id=7)

    event = redis.published[0][1]
    assert event["revision"] == 1
    assert "live-revision:user-1:projects" in redis.keys
    assert all("live-revision:user-1" not in key or key.endswith(":projects") for key in redis.keys)
