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

    async def fake_drain(user_id, settings, session_id=None):
        await fake_reflect(user_id, "小北", "\n".join(
            f"用户消息{i}" for i in range(1, 4)), "\n".join(
            f"回复{i}" for i in range(1, 4)), settings,
            turns=[{"session_id": session_id}] * 3)
        await fake_redis.delete(reflection._owner_reflection_buffer_key(user_id, session_id))

    monkeypatch.setattr(reflection, "_drain_owner_reflection_buffer", fake_drain)
    settings = SimpleNamespace(agent=SimpleNamespace(reflection_threshold=3))

    for index in range(1, 3):
        await reflection._queue_owner_reflection(
            "owner-1", "小北", f"用户消息{index}", f"回复{index}", settings, 7,
        )
    assert reflected == []

    await reflection._queue_owner_reflection(
        "owner-1", "小北", "用户消息3", "回复3", settings, 7,
    )

    assert len(reflected) == 1
    assert reflected[0][1] == "用户消息1\n用户消息2\n用户消息3"
    assert reflected[0][2] == "回复1\n回复2\n回复3"
    assert len(reflected[0][3]) == 3
    assert await fake_redis.llen(reflection._owner_reflection_buffer_key("owner-1", 7)) == 0


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
            "owner-2", "小北", f"群主消息{index}", "", settings, index,
        )
    assert drained == []

    await reflection._schedule_group_owner(
        "owner-2", "小北", "群主消息3", "", settings, 3,
    )
    assert drained == [("owner-2", settings)]


@pytest.mark.asyncio
async def test_tool_turn_no_longer_flushes_before_threshold(monkeypatch):
    """工具回合不再立即冲刷：与普通回合同一口径，只按 admin 阈值计数。"""
    from agent.memory import reflection
    import app.core.redis as redis_module

    fake_redis = _FakeRedis()
    monkeypatch.setattr(redis_module, "get_redis", lambda: fake_redis)
    drained = []

    async def fake_drain(user_id, settings, session_id=None):
        drained.append(user_id)

    monkeypatch.setattr(reflection, "_drain_owner_reflection_buffer", fake_drain)
    settings = SimpleNamespace(agent=SimpleNamespace(reflection_threshold=5))

    # 连续三个工具回合（旧逻辑会每次立即冲刷），阈值未到不应触发
    for index in range(3):
        await reflection._queue_owner_reflection(
            "owner-3", "小北", f"工具回合{index}", "已执行", settings, 7,
        )
    assert drained == []
    assert await fake_redis.llen(reflection._owner_reflection_buffer_key("owner-3", 7)) == 3
