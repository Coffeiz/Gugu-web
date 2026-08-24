"""Phase 6：会话单任务 gate 与 pending 持久状态回归测试。"""

from types import SimpleNamespace

import pytest

from agent.context import compress_conv
from app.models import ConversationSession


class _FakeLock:
    def __init__(self):
        self.acquired = False

    async def acquire(self, **_kwargs):
        self.acquired = True
        return True

    async def release(self):
        self.acquired = False


class _FakeRedis:
    def __init__(self):
        self.lock_instance = _FakeLock()

    def lock(self, *_args, **_kwargs):
        return self.lock_instance


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
