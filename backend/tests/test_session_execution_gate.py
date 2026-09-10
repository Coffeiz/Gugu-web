"""Phase 6：会话单任务 gate 与 pending 持久状态回归测试。"""

import asyncio

from types import SimpleNamespace

import pytest

from agent.context import compress_conv
from app.models import ConversationSession


class _FakeLock:
    def __init__(self):
        self.acquired = False
        self.release_calls = 0
        self.reacquire_result = True

    async def acquire(self, **_kwargs):
        self.acquired = True
        return True

    async def release(self):
        self.release_calls += 1
        self.acquired = False

    async def reacquire(self):
        self.acquired = bool(self.reacquire_result)
        return self.reacquire_result


class _FakeRedis:
    def __init__(self):
        self.lock_instance = _FakeLock()
        self.values = {}

    def lock(self, *_args, **_kwargs):
        return self.lock_instance

    async def exists(self, key):
        return int(key in self.values)

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, **_kwargs):
        self.values[key] = value
        return True

    async def expire(self, key, _ttl):
        return key in self.values

    async def delete(self, *keys):
        for key in keys:
            self.values.pop(key, None)
        return True


@pytest.mark.asyncio
async def test_session_gate_persists_pending_and_clears_active_state(db, user_a, monkeypatch):
    session = ConversationSession(
        user_id=user_a.id,
        title="串行测试",
        source="web",
        execution_state="running",
        active_run_id="run-existing",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    fake_redis = _FakeRedis()
    monkeypatch.setattr("app.core.redis.get_redis", lambda: fake_redis)
    monkeypatch.setattr("agent.llm.genstream.get_redis", lambda: fake_redis)
    request = SimpleNamespace(
        session_id=session.id,
        user_id=user_a.id,
        source="web",
        chat_type=None,
        chat_id=None,
        platform_bot_id=None,
        platform_user_id=None,
    )

    async with compress_conv.session_run_gate(request):
        await db.refresh(session)
        assert session.execution_state == "running"
        assert session.active_run_id and session.active_run_id.startswith("run-")
        # 已有任务时新请求先进入 pending；取得 gate 后消费自己的 pending 计数。
        assert session.pending_message_count == 0

    await db.refresh(session)
    assert session.execution_state == "idle"
    assert session.active_run_id is None
    assert session.pending_message_count == 0


@pytest.mark.asyncio
async def test_session_gate_does_not_create_pending_without_existing_session(db, user_a, monkeypatch):
    fake_redis = _FakeRedis()
    monkeypatch.setattr("app.core.redis.get_redis", lambda: fake_redis)
    request = SimpleNamespace(
        session_id=None,
        user_id=user_a.id,
        source="qq",
        chat_type="group",
        chat_id="group-test",
        platform_bot_id="bot-test",
        platform_user_id="member-test",
    )

    async with compress_conv.session_run_gate(request):
        assert not fake_redis.lock_instance.acquired

    assert not fake_redis.lock_instance.acquired


@pytest.mark.asyncio
async def test_session_gate_skips_release_after_lock_lease_is_lost(db, user_a, monkeypatch):
    session = ConversationSession(
        user_id=user_a.id,
        title="租约失效测试",
        source="web",
        execution_state="idle",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    fake_redis = _FakeRedis()
    fake_redis.lock_instance.reacquire_result = False
    monkeypatch.setattr("app.core.redis.get_redis", lambda: fake_redis)
    monkeypatch.setattr("agent.llm.genstream.get_redis", lambda: fake_redis)
    monkeypatch.setattr(compress_conv, "_SESSION_RUN_HEARTBEAT_INTERVAL", 0)
    request = SimpleNamespace(session_id=session.id, user_id=user_a.id)

    async with compress_conv.session_run_gate(request):
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    assert fake_redis.lock_instance.release_calls == 0


@pytest.mark.asyncio
async def test_recover_orphaned_session_clears_running_state_when_redis_state_is_gone(
    db, user_a, monkeypatch,
):
    session = ConversationSession(
        user_id=user_a.id,
        title="孤儿生成测试",
        source="web",
        execution_state="running",
        active_run_id="run-dead-worker",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    fake_redis = _FakeRedis()
    monkeypatch.setattr("agent.llm.genstream.get_redis", lambda: fake_redis)

    assert await compress_conv.recover_orphaned_session(session.id, user_a.id) is True

    await db.refresh(session)
    assert session.execution_state == "idle"
    assert session.active_run_id is None


@pytest.mark.asyncio
async def test_recover_orphaned_session_keeps_running_state_when_generation_is_alive(
    db, user_a, monkeypatch,
):
    session = ConversationSession(
        user_id=user_a.id,
        title="活跃生成测试",
        source="web",
        execution_state="running",
        active_run_id="run-live",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    fake_redis = _FakeRedis()
    fake_redis.values["genstream:state:%s" % session.id] = '{"done": false}'
    # 活跃生成的标志：run 进程心跳仍在续期
    fake_redis.values["genstream:beat:%s" % session.id] = "1"
    monkeypatch.setattr("agent.llm.genstream.get_redis", lambda: fake_redis)

    assert await compress_conv.recover_orphaned_session(session.id, user_a.id) is False

    await db.refresh(session)
    assert session.execution_state == "running"
    assert session.active_run_id == "run-live"


@pytest.mark.asyncio
async def test_recover_orphaned_session_reaps_zombie_snapshot(db, user_a, monkeypatch):
    """快照非 done 但进程心跳已断：连同 Redis 残留一起回收。"""
    session = ConversationSession(
        user_id=user_a.id,
        title="僵尸快照测试",
        source="web",
        execution_state="running",
        active_run_id="run-dead",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    fake_redis = _FakeRedis()
    fake_redis.values["genstream:state:%s" % session.id] = '{"done": false}'
    fake_redis.values["genstream:owner:%s" % session.id] = "run-dead"
    fake_redis.values["genstream:lease:%s" % session.id] = "run-dead"
    fake_redis.values["genstream:cancel:%s" % session.id] = "1"
    # 没有 beat 键 = 心跳已断
    monkeypatch.setattr("agent.llm.genstream.get_redis", lambda: fake_redis)

    assert await compress_conv.recover_orphaned_session(session.id, user_a.id) is True

    await db.refresh(session)
    assert session.execution_state == "idle"
    assert session.active_run_id is None
    assert "genstream:state:%s" % session.id not in fake_redis.values
    assert "genstream:owner:%s" % session.id not in fake_redis.values
    assert "genstream:lease:%s" % session.id not in fake_redis.values
    assert "genstream:cancel:%s" % session.id not in fake_redis.values


@pytest.mark.asyncio
async def test_recover_orphaned_session_does_not_clear_state_when_redis_is_unavailable(
    db, user_a, monkeypatch,
):
    session = ConversationSession(
        user_id=user_a.id,
        title="Redis 故障测试",
        source="web",
        execution_state="running",
        active_run_id="run-redis-outage",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    class _UnavailableRedis:
        async def get(self, _key):
            raise ConnectionError("redis unavailable")

    monkeypatch.setattr("agent.llm.genstream.get_redis", lambda: _UnavailableRedis())

    assert await compress_conv.recover_orphaned_session(session.id, user_a.id) is False

    await db.refresh(session)
    assert session.execution_state == "running"
    assert session.active_run_id == "run-redis-outage"


@pytest.mark.asyncio
async def test_recover_orphaned_session_clears_baseline_updating_when_compress_lock_gone(
    db, user_a, monkeypatch,
):
    """重启打断基线提交：压缩锁（带 TTL）已消失 = 写进程不在，回收孤儿态。"""
    session = ConversationSession(
        user_id=user_a.id,
        title="基线孤儿测试",
        source="web",
        execution_state="baseline_updating",
        active_run_id=None,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    fake_redis = _FakeRedis()
    monkeypatch.setattr("agent.llm.genstream.get_redis", lambda: fake_redis)
    monkeypatch.setattr("app.core.redis.get_redis", lambda: fake_redis)

    assert await compress_conv.recover_orphaned_session(session.id, user_a.id) is True

    await db.refresh(session)
    assert session.execution_state == "idle"
    assert session.active_run_id is None


@pytest.mark.asyncio
async def test_recover_orphaned_session_keeps_baseline_updating_while_lock_held(
    db, user_a, monkeypatch,
):
    """压缩锁仍在 = 基线提交正在进行，绝不能回收。"""
    session = ConversationSession(
        user_id=user_a.id,
        title="基线进行中测试",
        source="web",
        execution_state="baseline_updating",
        active_run_id=None,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    fake_redis = _FakeRedis()
    fake_redis.values["agent:context:compress:%s" % session.id] = "1"
    monkeypatch.setattr("agent.llm.genstream.get_redis", lambda: fake_redis)
    monkeypatch.setattr("app.core.redis.get_redis", lambda: fake_redis)

    assert await compress_conv.recover_orphaned_session(session.id, user_a.id) is False

    await db.refresh(session)
    assert session.execution_state == "baseline_updating"
