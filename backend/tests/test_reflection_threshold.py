from __future__ import annotations

from types import SimpleNamespace

import pytest


class _FakeLock:
    async def acquire(self, blocking=False):
        return True

    async def release(self):
        return None


class _FakeRedis:
    def __init__(self):
        self.lists = {}
        self.zsets = {}

    def lock(self, _key, timeout=None):
        return _FakeLock()

    async def rpush(self, key, *values):
        self.lists.setdefault(key, []).extend(values)
        return len(self.lists[key])

    async def llen(self, key):
        return len(self.lists.get(key, []))

    async def lrange(self, key, start, end):
        values = self.lists.get(key, [])
        if end == -1:
            return values[start:]
        return values[start:end + 1]

    async def delete(self, key):
        self.lists.pop(key, None)

    async def zadd(self, key, values):
        self.zsets.setdefault(key, {}).update(values)


@pytest.mark.asyncio
async def test_owner_reflection_waits_for_configured_turn_threshold(monkeypatch):
    from agent.memory import reflection
    import app.core.redis as redis_module

    fake_redis = _FakeRedis()
    monkeypatch.setattr(redis_module, "get_redis", lambda: fake_redis)
    reflected = []

    async def fake_reflect(user_id, user_name, user_msg, assistant_reply, settings, **kwargs):
        reflected.append((user_id, user_msg, assistant_reply, kwargs["turns"]))
        return True

    monkeypatch.setattr(reflection, "reflect", fake_reflect)
    settings = SimpleNamespace(agent=SimpleNamespace(reflection_threshold=3))

    for index in range(1, 3):
        await reflection._queue_owner_reflection(
            "owner-1", "小北", f"用户消息{index}", f"回复{index}", settings, False, index,
        )
    assert reflected == []

    await reflection._queue_owner_reflection(
        "owner-1", "小北", "用户消息3", "回复3", settings, False, 3,
    )

    assert len(reflected) == 1
    assert reflected[0][1] == "用户消息1\n用户消息2\n用户消息3"
    assert reflected[0][2] == "回复1\n回复2\n回复3"
    assert len(reflected[0][3]) == 3
    assert await fake_redis.llen(reflection._owner_reflection_buffer_key("owner-1")) == 0


def test_owner_reflection_threshold_has_safe_default():
    from agent.memory import reflection

    assert reflection._owner_reflection_threshold(SimpleNamespace(agent=SimpleNamespace(reflection_threshold=7))) == 7
    assert reflection._owner_reflection_threshold(SimpleNamespace(agent=SimpleNamespace(reflection_threshold=0))) == 1
    assert reflection._owner_reflection_threshold(SimpleNamespace()) == 10


@pytest.mark.asyncio
async def test_group_owner_uses_owner_threshold_without_changing_group_scope(monkeypatch):
    from agent.memory import reflection
    import app.core.redis as redis_module

    fake_redis = _FakeRedis()
    monkeypatch.setattr(redis_module, "get_redis", lambda: fake_redis)
    drained = []

    async def fake_drain(user_id, settings):
        drained.append((user_id, settings))

    monkeypatch.setattr(reflection, "_drain_group_owner_buffer", fake_drain)
    settings = SimpleNamespace(agent=SimpleNamespace(reflection_threshold=3))

    for index in range(1, 3):
        await reflection._schedule_group_owner(
            "owner-2", "小北", f"群主消息{index}", "", settings, False, index,
        )
    assert drained == []

    await reflection._schedule_group_owner(
        "owner-2", "小北", "群主消息3", "", settings, False, 3,
    )
    assert drained == [("owner-2", settings)]
