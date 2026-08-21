import pytest

from app.core import events


class _Redis:
    def __init__(self):
        self.calls = []

    async def incr(self, key):
        self.calls.append(("incr", key))
        return 1

    async def expire(self, key, seconds):
        self.calls.append(("expire", key, seconds))


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["preferences", "timezone", "im_channels"])
async def test_snapshot_inputs_bump_revision_without_sse_resource(source, monkeypatch):
    redis = _Redis()
    monkeypatch.setattr(events, "get_redis", lambda: redis)

    await events.bump_context_revision("user-1", source)

    assert redis.calls == [
        ("incr", "context-revision:user-1"),
        ("expire", "context-revision:user-1", 60 * 60 * 24 * 7),
    ]


@pytest.mark.asyncio
async def test_unknown_revision_source_is_ignored(monkeypatch):
    redis = _Redis()
    monkeypatch.setattr(events, "get_redis", lambda: redis)

    await events.bump_context_revision("user-1", "ui_layout")

    assert redis.calls == []
