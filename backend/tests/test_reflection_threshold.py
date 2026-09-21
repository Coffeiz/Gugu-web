from __future__ import annotations

import json
from datetime import datetime, timezone
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

    async def zrem(self, key, member):
        self.zsets.setdefault(key, {}).pop(member, None)

    async def zscore(self, key, member):
        return self.zsets.get(key, {}).get(member)

    async def zrangebyscore(self, key, minimum, maximum, *, start=0, num=100):
        rows = [member for member, score in self.zsets.get(key, {}).items()
                if float(minimum) <= float(score) <= float(maximum)]
        return rows[start:start + num]


@pytest.mark.asyncio
async def test_web_owner_reflection_uses_web_private_turn_threshold(monkeypatch):
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
    settings = SimpleNamespace(agent=SimpleNamespace(web_private_reflection_threshold=3))

    for index in range(1, 3):
        await reflection._queue_owner_reflection(
            "owner-1", "小北", f"用户消息{index}", f"回复{index}", settings, 7,
        )
    assert reflected == []
    assert reflection._owner_idle_member("owner-1", 7) in fake_redis.zsets[
        reflection.reflection_idle.OWNER_IDLE_KEY
    ]

    await reflection._queue_owner_reflection(
        "owner-1", "小北", "用户消息3", "回复3", settings, 7,
    )

    assert len(reflected) == 1
    assert reflected[0][1] == "用户消息1\n用户消息2\n用户消息3"
    assert reflected[0][2] == "回复1\n回复2\n回复3"
    assert len(reflected[0][3]) == 3
    assert await fake_redis.llen(reflection._owner_reflection_buffer_key("owner-1", 7)) == 0


def test_web_private_reflection_threshold_has_safe_default():
    from agent.memory import reflection

    assert reflection._web_private_reflection_threshold(
        SimpleNamespace(agent=SimpleNamespace(web_private_reflection_threshold=7))
    ) == 7
    assert reflection._web_private_reflection_threshold(
        SimpleNamespace(agent=SimpleNamespace(web_private_reflection_threshold=0))
    ) == 1
    assert reflection._web_private_reflection_threshold(SimpleNamespace()) == 10


def test_web_private_reflection_threshold_ignores_legacy_config_key():
    from app.core.config import AgentBehaviorSettings

    assert AgentBehaviorSettings.model_validate({}).web_private_reflection_threshold == 10
    assert AgentBehaviorSettings.model_validate(
        {"reflection_threshold": 7}
    ).web_private_reflection_threshold == 10
    assert AgentBehaviorSettings.model_validate({
        "reflection_threshold": 7,
        "web_private_reflection_threshold": 4,
    }).web_private_reflection_threshold == 4


@pytest.mark.parametrize("value", [0, 101])
def test_web_private_reflection_threshold_rejects_values_outside_admin_range(value):
    from pydantic import ValidationError

    from app.core.config import AgentBehaviorSettings

    with pytest.raises(ValidationError):
        AgentBehaviorSettings.model_validate({"web_private_reflection_threshold": value})


@pytest.mark.asyncio
async def test_reflection_idle_window_flushes_after_three_minutes_for_owner_and_group():
    from agent.memory import reflection_idle

    fake_redis = _FakeRedis()
    now = 10_000.0
    due_member = "idle-exactly-three-minutes"
    active_member = "idle-two-minutes-fifty-nine-seconds"
    for key in (reflection_idle.OWNER_IDLE_KEY, reflection_idle.GROUP_OWNER_IDLE_KEY):
        fake_redis.zsets[key] = {
            due_member: now - 180,
            active_member: now - 179,
        }

        assert await reflection_idle.due_members(fake_redis, key, now=now) == [due_member]
        assert await reflection_idle.is_due(fake_redis, key, due_member, now=now)
        assert not await reflection_idle.is_due(fake_redis, key, active_member, now=now)

    cutoff_input = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)
    assert reflection_idle.idle_cutoff(cutoff_input) == datetime(
        2026, 9, 20, 11, 57, tzinfo=timezone.utc,
    )


@pytest.mark.asyncio
async def test_group_owner_uses_group_threshold_not_private_threshold(monkeypatch):
    from agent.memory import reflection
    import app.core.redis as redis_module

    fake_redis = _FakeRedis()
    monkeypatch.setattr(redis_module, "get_redis", lambda: fake_redis)
    drained = []

    async def fake_drain(user_id, settings, session_id=None):
        drained.append((user_id, settings, session_id))

    monkeypatch.setattr(reflection, "_drain_group_owner_buffer", fake_drain)
    settings = SimpleNamespace(agent=SimpleNamespace(web_private_reflection_threshold=3))

    for index in range(1, 51):
        await reflection._schedule_group_owner(
            "owner-2", "小北", f"群主消息{index}", "", settings, 7,
        )
    assert drained == []

    await reflection._schedule_group_owner(
        "owner-2", "小北", "群主消息51", "", settings, 7, flush_now=True,
    )
    assert drained == [("owner-2", settings, 7)]


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
    settings = SimpleNamespace(agent=SimpleNamespace(web_private_reflection_threshold=5))

    # 连续三个工具回合（旧逻辑会每次立即冲刷），阈值未到不应触发
    for index in range(3):
        await reflection._queue_owner_reflection(
            "owner-3", "小北", f"工具回合{index}", "已执行", settings, 7,
        )
    assert drained == []
    assert await fake_redis.llen(reflection._owner_reflection_buffer_key("owner-3", 7)) == 3


@pytest.mark.asyncio
async def test_owner_idle_scanner_rebuilds_only_due_session_buffers(monkeypatch):
    from agent.memory import reflection, reflection_idle
    import app.core.redis as redis_module

    now = 10_000.0
    due_score = now - reflection_idle.IDLE_WINDOW_SECONDS - 1
    fake_redis = _FakeRedis()
    fake_redis.zsets[reflection_idle.OWNER_IDLE_KEY] = {
        reflection._owner_idle_member("owner-a", 7): due_score,
        reflection._owner_idle_member("owner-b", 8): now - 30,
    }
    fake_redis.zsets[reflection_idle.GROUP_OWNER_IDLE_KEY] = {
        reflection._owner_idle_member("owner-c", 9): due_score,
    }
    monkeypatch.setattr(redis_module, "get_redis", lambda: fake_redis)
    drained = []

    async def fake_owner(user_id, settings, session_id=None, *, allow_rebuild=False):
        drained.append(("owner", user_id, session_id, allow_rebuild))

    async def fake_group(user_id, settings, session_id=None, *, allow_rebuild=False):
        drained.append(("group", user_id, session_id, allow_rebuild))

    monkeypatch.setattr(reflection, "_drain_owner_reflection_buffer", fake_owner)
    monkeypatch.setattr(reflection, "_drain_group_owner_buffer", fake_group)
    settings = SimpleNamespace()

    assert await reflection.flush_due_owner_reflections(settings, now=now) == 2
    tasks = list(reflection._bg_tasks)
    if tasks:
        await __import__("asyncio").gather(*tasks)
    assert sorted(drained) == [
        ("group", "owner-c", 9, True),
        ("owner", "owner-a", 7, True),
    ]


@pytest.mark.asyncio
async def test_idle_drain_rechecks_activity_after_acquiring_lock(monkeypatch):
    from agent.memory import reflection, reflection_idle
    import app.core.redis as redis_module

    fake_redis = _FakeRedis()
    key = reflection._owner_reflection_buffer_key("owner-race", 17)
    member = reflection._owner_idle_member("owner-race", 17)
    fake_redis.lists[key] = ['{"session_id":17,"user_msg":"新消息"}']
    fake_redis.zsets[reflection_idle.OWNER_IDLE_KEY] = {
        member: __import__("time").time(),
    }
    monkeypatch.setattr(redis_module, "get_redis", lambda: fake_redis)
    calls = []

    async def fake_reflect(*_args, **_kwargs):
        calls.append(True)
        return True

    monkeypatch.setattr(reflection, "reflect", fake_reflect)
    await reflection._drain_owner_reflection_buffer(
        "owner-race", SimpleNamespace(), 17, allow_rebuild=True,
    )
    assert calls == []
    assert fake_redis.lists[key] == ['{"session_id":17,"user_msg":"新消息"}']


@pytest.mark.asyncio
async def test_legacy_group_owner_queue_migrates_by_session(monkeypatch):
    from agent.memory import reflection
    import app.core.redis as redis_module

    now = 20_000.0
    fake_redis = _FakeRedis()
    legacy_key = f"{reflection._GROUP_OWNER_BUFFER_PREFIX}owner-old"
    fake_redis.lists[legacy_key] = [
        '{"user_name":"小北","user_msg":"甲","assistant_reply":"","session_id":31}',
        '{"user_name":"小北","user_msg":"乙","assistant_reply":"","session_id":32}',
    ]
    fake_redis.zsets[reflection._GROUP_OWNER_IDLE_KEY] = {"owner-old": now - 1000}
    monkeypatch.setattr(redis_module, "get_redis", lambda: fake_redis)

    assert await reflection.flush_due_owner_reflections(SimpleNamespace(), now=now) == 1
    assert legacy_key not in fake_redis.lists
    assert fake_redis.lists[reflection._owner_group_buffer_key("owner-old", 31)] == [
        '{"user_name":"小北","user_msg":"甲","assistant_reply":"","session_id":31}'
    ]
    assert fake_redis.lists[reflection._owner_group_buffer_key("owner-old", 32)] == [
        '{"user_name":"小北","user_msg":"乙","assistant_reply":"","session_id":32}'
    ]
    assert "owner-old" not in fake_redis.zsets[reflection._GROUP_OWNER_IDLE_KEY]


@pytest.mark.asyncio
async def test_legacy_owner_private_queue_migrates_by_session_on_next_activity(monkeypatch):
    from agent.memory import reflection
    import app.core.redis as redis_module

    fake_redis = _FakeRedis()
    legacy_key = f"{reflection._OWNER_REFLECTION_BUFFER_PREFIX}owner-old"
    legacy_rows = [
        '{"user_name":"小北","user_msg":"旧私聊一","assistant_reply":"回复一","session_id":31}',
        '{"user_name":"小北","user_msg":"旧私聊二","assistant_reply":"回复二","session_id":32}',
    ]
    fake_redis.lists[legacy_key] = list(legacy_rows)
    monkeypatch.setattr(redis_module, "get_redis", lambda: fake_redis)
    settings = SimpleNamespace(agent=SimpleNamespace(web_private_reflection_threshold=10))

    await reflection._queue_owner_reflection(
        "owner-old", "小北", "当前私聊", "当前回复", settings, 31,
    )

    session_31 = reflection._owner_reflection_buffer_key("owner-old", 31)
    session_32 = reflection._owner_reflection_buffer_key("owner-old", 32)
    assert legacy_key not in fake_redis.lists
    assert len(fake_redis.lists[session_31]) == 2
    assert fake_redis.lists[session_31][0] == legacy_rows[0]
    assert json.loads(fake_redis.lists[session_31][1])["user_msg"] == "当前私聊"
    assert fake_redis.lists[session_32] == [legacy_rows[1]]
    idle_members = fake_redis.zsets[reflection.reflection_idle.OWNER_IDLE_KEY]
    assert reflection._owner_idle_member("owner-old", 31) in idle_members
    assert reflection._owner_idle_member("owner-old", 32) in idle_members
