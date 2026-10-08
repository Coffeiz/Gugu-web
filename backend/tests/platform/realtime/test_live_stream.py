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

    queue_event = _event(resource="pending_queues", entity_id=388)
    queue_frame = live._serialize_message(json.dumps(queue_event))
    assert queue_frame is not None
    assert json.loads(queue_frame.removeprefix("data: ").strip()) == queue_event

    notification = live._serialize_message(json.dumps({"notification": {"id": 1}}))
    assert notification is not None


def test_serialize_live_message_accepts_valid_trash_purge_progress_only():
    event = {
        "protocol_version": "live-event-v1",
        "event_id": "evt-purge-1",
        "type": "task.progress",
        "task_type": "trash_purge",
        "task_id": 12,
        "status": "running",
        "progress_current": 10,
        "progress_total": 40,
        "failed_count": 0,
        "created_at": "2026-10-06T00:00:00+00:00",
    }
    frame = live._serialize_message(json.dumps(event))
    assert frame is not None
    assert json.loads(frame.removeprefix("data: ").strip()) == event

    assert live._serialize_message(json.dumps({**event, "task_id": True})) is None
    assert live._serialize_message(json.dumps({**event, "status": "unknown"})) is None


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

    channels = ("events:user-1", live.BROADCAST_CHANNEL)
    frames = [frame async for frame in live._event_stream(request, channels)]

    assert frames[0] == ": connected\n\n"
    assert frames[1].startswith("data: ")
    assert pubsub.subscribed == channels
    assert pubsub.unsubscribed == pubsub.subscribed
    assert pubsub.closed is True


@pytest.mark.asyncio
async def test_event_stream_stops_after_account_is_suspended(monkeypatch):
    request = _Request()
    pubsub = _PubSub(request)
    monkeypatch.setattr(live, "get_redis", lambda: _Redis(pubsub))

    async def inactive(_user_id):
        return False

    frames = [frame async for frame in live._event_stream(
        request, ("events:user-1",), active_check=inactive, active_user_id="user-1",
    )]
    assert frames == [": connected\n\n", "event: account_suspended\ndata: {\"message\":\"账号暂时不可用\"}\n\n"]
    assert pubsub.closed is True


@pytest.mark.asyncio
async def test_event_stream_ends_cleanly_when_redis_disconnects(monkeypatch):
    request = _Request()
    pubsub = _DisconnectingPubSub(request)
    monkeypatch.setattr(live, "get_redis", lambda: _Redis(pubsub))

    frames = [frame async for frame in live._event_stream(request, ("events:user-1",))]

    assert frames == [": connected\n\n", ": live connection reset; client will reconnect\n\n"]
    assert pubsub.closed is True


@pytest.mark.parametrize("event", [
    {
        "protocol_version": "live-event-v1", "event_id": "evt-run-1",
        "type": "filesync.run.changed", "run_id": "run-1", "binding_id": 7,
        "revision": 3, "created_at": "2026-10-07T00:00:00+00:00",
    },
    {
        "protocol_version": "live-event-v1", "event_id": "evt-health-1",
        "type": "filesync.binding.health.changed", "binding_id": 7,
        "revision": 4, "created_at": "2026-10-07T00:00:00+00:00",
    },
])
def test_serialize_filesync_invalidation_exposes_only_safe_snapshot_keys(event):
    unsafe = {**event, "root_path": "/private/user/files", "relative_path": "secret.txt"}
    frame = live._serialize_message(json.dumps(unsafe))

    assert frame is not None
    serialized = json.loads(frame.removeprefix("data: ").strip())
    assert serialized == event
    assert "root_path" not in serialized
    assert "relative_path" not in serialized


def test_serialize_filesync_invalidation_rejects_invalid_revision_and_timestamp():
    event = {
        "protocol_version": "live-event-v1", "event_id": "evt-run-1",
        "type": "filesync.run.changed", "run_id": "run-1", "binding_id": 7,
        "revision": 3, "created_at": "2026-10-07T00:00:00+00:00",
    }
    assert live._serialize_message(json.dumps({**event, "revision": True})) is None
    assert live._serialize_message(json.dumps({**event, "binding_id": 0})) is None
    assert live._serialize_message(json.dumps({**event, "created_at": "not-a-date"})) is None
    assert live._serialize_message(json.dumps({**event, "type": "filesync.unknown"})) is None


@pytest.mark.asyncio
async def test_publish_filesync_events_to_owner_and_admin_without_payload_details(monkeypatch):
    class Redis:
        def __init__(self):
            self.published = []
            self.throttle = {}

        async def set(self, key, value, *, ex, nx):
            assert ex == 1 and nx is True
            if key in self.throttle:
                return False
            self.throttle[key] = value
            return True

        async def publish(self, channel, value):
            self.published.append((channel, json.loads(value)))

    redis = Redis()
    monkeypatch.setattr(events, "get_redis", lambda: redis)
    await events.publish_filesync_run_changed(
        "user-1", run_id="run-1", binding_id=7, revision=2, coalesce=True,
    )

    assert [channel for channel, _ in redis.published] == [
        "events:user-1", events.FILESYNC_ADMIN_CHANNEL,
    ]
    payload = redis.published[0][1]
    assert payload["type"] == "filesync.run.changed"
    assert payload["run_id"] == "run-1"
    assert payload["revision"] == 2
    assert not {"root_path", "relative_path", "scan_result"}.intersection(payload)


@pytest.mark.asyncio
async def test_coalesced_filesync_progress_drops_duplicate_window_but_keeps_terminal_publish(monkeypatch):
    class Redis:
        def __init__(self):
            self.keys = set()
            self.published = []

        async def set(self, key, _value, **_kwargs):
            if key in self.keys:
                return False
            self.keys.add(key)
            return True

        async def publish(self, channel, value):
            self.published.append((channel, json.loads(value)))

    redis = Redis()
    monkeypatch.setattr(events, "get_redis", lambda: redis)
    await events.publish_filesync_run_changed(
        "user-1", run_id="run-1", binding_id=7, revision=2, coalesce=True,
    )
    await events.publish_filesync_run_changed(
        "user-1", run_id="run-1", binding_id=7, revision=3, coalesce=True,
    )
    await events.publish_filesync_run_changed(
        "user-1", run_id="run-1", binding_id=7, revision=4,
    )

    assert len(redis.published) == 4
    assert redis.published[-1][1]["revision"] == 4


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


@pytest.mark.asyncio
async def test_publish_notification_without_resource_is_not_dropped(monkeypatch):
    class Redis:
        def __init__(self):
            self.published = []

        async def publish(self, channel, value):
            self.published.append((channel, json.loads(value)))

    redis = Redis()
    monkeypatch.setattr(events, "get_redis", lambda: redis)

    note = {"id": 9, "title": "定时任务", "content": "执行结果", "bubble": True, "persist": True}
    assert await events.publish("user-1", notification=note) is True
    assert redis.published == [("events:user-1", {"notification": note})]
