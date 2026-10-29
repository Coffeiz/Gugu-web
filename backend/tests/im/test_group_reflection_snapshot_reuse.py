"""群反思真实历史恢复、快照扩展和本地闲置调度的回归。"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.context.provider_conversation import ProviderConversation
from agent.context.reflection_snapshot import ReflectionSnapshot
from agent.memory import im_reflection, reflection_jobs
from agent.memory.scopes import MemoryScope
from app.models import ConversationMessage, ConversationSession


@pytest.fixture(autouse=True)
def _reset_local_group_snapshot_tasks(monkeypatch):
    monkeypatch.setattr(reflection_jobs, "_LOCAL_IDLE_SNAPSHOT_TASKS", {})
    monkeypatch.setattr(reflection_jobs, "_LOCAL_IDLE_SNAPSHOT_DRAINING", set())
    monkeypatch.setattr(reflection_jobs, "_LOCAL_SNAPSHOT_TASKS", set())


async def test_worker_shutdown_drains_idle_snapshot_timer(monkeypatch):
    """关闭 worker 时等待定时器清理标记，避免事件循环关闭后才运行 finally。"""
    from app.core import redis as redis_module

    class Redis:
        def __init__(self):
            self.values = {}

        async def set(self, key, value, ex):
            self.values[key] = value

        async def eval(self, script, numkeys, key, token, *args):
            if self.values.get(key) == token:
                self.values.pop(key, None)
                return 1
            return 0

    redis = Redis()
    monkeypatch.setattr(redis_module, "get_redis", lambda: redis)
    scope = MemoryScope("owner-synthetic", "qq", "bot-synthetic", "group", "group-synthetic")
    assert await reflection_jobs._arm_local_idle_snapshot(scope, 7, SimpleNamespace(), "snapshot")
    task = reflection_jobs._LOCAL_IDLE_SNAPSHOT_TASKS[f"{scope.prefix}:7"]
    await reflection_jobs.shutdown_local_idle_snapshots()
    assert task.done()
    assert not reflection_jobs._LOCAL_IDLE_SNAPSHOT_TASKS
    assert not redis.values


async def test_shutdown_waits_for_previous_draining_snapshot_and_cancels_new_timer(monkeypatch):
    """同一群旧任务正在收束而新计时器已注册时，两者都须有序收尾。"""
    from app.core import redis as redis_module

    class Redis:
        def __init__(self):
            self.values = {}

        async def set(self, key, value, ex):
            self.values[key] = value

        async def eval(self, script, numkeys, key, token, *args):
            if self.values.get(key) == token:
                self.values.pop(key, None)
                return 1
            return 0

    redis = Redis()
    monkeypatch.setattr(redis_module, "get_redis", lambda: redis)
    scope = MemoryScope("owner-synthetic", "qq", "bot-synthetic", "group", "group-synthetic")
    release = asyncio.Event()
    old_task = asyncio.create_task(release.wait())
    key = f"{scope.prefix}:7"
    reflection_jobs._LOCAL_IDLE_SNAPSHOT_TASKS[key] = old_task
    reflection_jobs._LOCAL_IDLE_SNAPSHOT_DRAINING.add(old_task)
    reflection_jobs._LOCAL_SNAPSHOT_TASKS.add(old_task)
    assert await reflection_jobs._arm_local_idle_snapshot(scope, 7, SimpleNamespace(), "new")
    new_task = reflection_jobs._LOCAL_IDLE_SNAPSHOT_TASKS[key]
    stopping = asyncio.create_task(reflection_jobs.shutdown_local_idle_snapshots())
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert not old_task.cancelled()
    assert not stopping.done()
    release.set()
    await asyncio.wait_for(stopping, 1)
    assert old_task.done() and new_task.done()
    assert not redis.values


async def _restored_group_snapshot(db, user_a, monkeypatch):
    scope = MemoryScope(user_a.id, "qq", "bot-synthetic", "group", "group-synthetic")
    session = ConversationSession(
        user_id=user_a.id,
        source=scope.platform,
        bot_id=scope.bot_id,
        chat_id=scope.scope_id,
        chat_type="group",
        platform_user_id="bot-member-synthetic",
        execution_state="idle",
    )
    db.add(session)
    await db.flush()
    sent_at = datetime(2026, 10, 20, 9, 30, tzinfo=timezone.utc)
    user_message = ConversationMessage(
        session_id=session.id,
        role="user",
        content="",
        content_json=[{"type": "text", "text": "项目进度已更新"}],
        platform_user_id="member-synthetic",
        platform_user_name="成员甲",
        sent_at=sent_at,
    )
    assistant_message = ConversationMessage(
        session_id=session.id,
        role="assistant",
        content="",
        content_json=[
            {"type": "thinking", "thinking": "合成思考块", "signature": "sig-synthetic"},
            {"type": "tool_call", "id": "call-synthetic", "name": "lookup", "arguments": {"query": "项目"}},
            {"type": "text", "text": "已检查项目状态"},
        ],
        # 时间戳只用于语义/展示；历史顺序由持久序号保证助手输出排在用户消息之后。
        sent_at=datetime(2026, 10, 20, 9, 30, 30, tzinfo=timezone.utc),
    )
    tool_message = ConversationMessage(
        session_id=session.id,
        role="tool",
        content="",
        content_json=[{
            "type": "tool_result", "tool_call_id": "call-synthetic", "content": "合成工具结果",
        }],
        sent_at=datetime(2026, 10, 20, 9, 30, 30, tzinfo=timezone.utc),
    )
    db.add_all([user_message, assistant_message, tool_message])
    await db.commit()

    monkeypatch.setattr("agent.context.session_system.build_static_prompt", lambda *a, **k: "静态合成提示")
    monkeypatch.setattr("agent.context.dynamic_tail.current_date_text", lambda _tz: "2026年10月20日")
    monkeypatch.setattr("agent.context.dynamic_tail.message_time_reminder", lambda *_a, **_k: {"content": "合成时间上下文"})
    monkeypatch.setattr("agent.context.loaders.load_style_prefs", AsyncMock(return_value={}))
    monkeypatch.setattr("agent.context.loaders.load_user_tz", AsyncMock(return_value=timezone.utc))
    monkeypatch.setattr("agent.llm.llm_select.use_anthropic_for", lambda _model: True)

    model = SimpleNamespace(provider="minimax", model="MiniMax-M3.1-Flash-Preview", api_format="anthropic")
    restored = await im_reflection._rebuild_session_snapshot(db, scope, session.id, model, [])
    assert restored is not None
    return scope, session, model, restored, assistant_message


def _captured_snapshot(base, user_id, session_id, model):
    return ReflectionSnapshot(
        user_id=str(user_id),
        session_id=session_id,
        run_id="synthetic-main-run",
        system_prompt="冻结的主 run system",
        ai=model,
        tools=({"name": "lookup"},),
        history=base,
        revision="synthetic-revision",
        created_at=0,
    )


@pytest.mark.asyncio
async def test_group_snapshot_extends_actual_restored_provider_history(db, user_a, monkeypatch):
    """真实历史恢复生成的时间、Thinking 与工具消息前缀可匹配并只追加被动尾部。"""
    scope, session, model, restored, _assistant = await _restored_group_snapshot(db, user_a, monkeypatch)
    base = ProviderConversation(restored.history)
    base_messages = base.to_messages()
    assert {item["role"] for item in base_messages} >= {"assistant", "user"}
    assert any(
        block.get("type") == "time-context" and block.get("text") == "合成时间上下文"
        for item in base_messages for block in item.get("content", []) if isinstance(block, dict)
    )
    assert any(
        block.get("type") == "thinking" and block.get("signature") == "sig-synthetic"
        for item in base_messages for block in item.get("content", []) if isinstance(block, dict)
    )
    assert any(
        block.get("type") == "tool_use" and block.get("id") == "call-synthetic"
        for item in base_messages for block in item.get("content", []) if isinstance(block, dict)
    )
    assert any(
        block.get("type") == "tool_result" and block.get("tool_use_id") == "call-synthetic"
        for item in base_messages for block in item.get("content", []) if isinstance(block, dict)
    )

    snapshot = _captured_snapshot(base, user_a.id, session.id, model)
    tail = ConversationMessage(
        session_id=session.id,
        role="user",
        content="风险项仍在观察",
        platform_user_id="member-synthetic",
        platform_user_name="成员甲",
        sent_at=datetime(2026, 10, 20, 9, 31, tzinfo=timezone.utc),
    )
    db.add(tail)
    await db.commit()

    persisted = await im_reflection._rebuild_session_snapshot(db, scope, session.id, model, [tail])
    assert persisted is not None
    extended = im_reflection._extend_snapshot_with_persisted_tail(snapshot, persisted)

    assert extended is not None
    assert extended.source == "in_memory_extended"
    assert extended.history.to_messages()[:len(base_messages)] == base_messages
    assert extended.history.to_messages()[-1]["content"] == "风险项仍在观察"
    assert extended.system_prompt == snapshot.system_prompt
    assert extended.tools == snapshot.tools


@pytest.mark.asyncio
async def test_group_snapshot_falls_back_when_restored_prefix_changed(db, user_a, monkeypatch):
    """数据库里原有复杂块变化后拒绝拼接，避免把新尾部接到不一致的 wire 前缀。"""
    scope, session, model, restored, assistant = await _restored_group_snapshot(db, user_a, monkeypatch)
    snapshot = _captured_snapshot(
        ProviderConversation(restored.history), user_a.id, session.id, model,
    )
    assistant.content_json = [
        {**assistant.content_json[0], "signature": "changed-signature"},
        *assistant.content_json[1:],
    ]
    tail = ConversationMessage(
        session_id=session.id,
        role="user",
        content="新增被动消息",
        platform_user_id="member-synthetic",
        sent_at=datetime(2026, 10, 20, 9, 31, tzinfo=timezone.utc),
    )
    db.add(tail)
    await db.commit()

    persisted = await im_reflection._rebuild_session_snapshot(db, scope, session.id, model, [tail])
    assert persisted is not None
    assert im_reflection._extend_snapshot_with_persisted_tail(snapshot, persisted) is None


@pytest.mark.asyncio
async def test_rearming_group_local_idle_snapshot_cancels_old_timer_without_deleting_new_marker(
    monkeypatch,
):
    """连续主动 run 会取消旧计时；旧任务收尾不能删除新 run 的协调标记。"""
    from app.core import redis as redis_module

    real_sleep = asyncio.sleep
    idle_gates = [asyncio.Event(), asyncio.Event()]
    started = [asyncio.Event(), asyncio.Event()]
    drain_called = []

    async def controlled_sleep(seconds):
        if seconds == reflection_jobs.IDLE_WINDOW.total_seconds():
            index = len([item for item in started if item.is_set()])
            started[index].set()
            await idle_gates[index].wait()
        else:
            await asyncio.Event().wait()

    class Redis:
        def __init__(self):
            self.values = {}
            self.expiries = []
            self.deleted = []

        async def set(self, key, value, ex):
            self.values[key] = value
            return True

        async def eval(self, script, numkeys, key, token, *args):
            assert numkeys == 1
            if script == reflection_jobs._REFRESH_LOCAL_IDLE_SNAPSHOT_MARKER_LUA:
                if self.values.get(key) != token:
                    return 0
                self.values[key] = token
                self.expiries.append(int(args[0]))
                return 1
            if script == reflection_jobs._DELETE_LOCAL_IDLE_SNAPSHOT_MARKER_LUA:
                if self.values.get(key) != token:
                    return 0
                self.deleted.append(key)
                self.values.pop(key, None)
                return 1
            raise AssertionError("收到未知 Redis Lua 脚本")

    redis = Redis()
    scope = MemoryScope("owner-synthetic", "qq", "bot-synthetic", "group", "group-synthetic")
    monkeypatch.setattr(redis_module, "get_redis", lambda: redis)
    monkeypatch.setattr(reflection_jobs, "_async_sleep", controlled_sleep)

    async def drain(_scope, _settings, snapshot):
        drain_called.append(snapshot)

    monkeypatch.setattr(reflection_jobs, "_settle_scope_with_snapshot", drain)
    assert await reflection_jobs._arm_local_idle_snapshot(scope, 7, SimpleNamespace(), "first")
    first_task = reflection_jobs._LOCAL_IDLE_SNAPSHOT_TASKS[f"{scope.prefix}:7"]
    await real_sleep(0)
    assert started[0].is_set()

    assert await reflection_jobs._arm_local_idle_snapshot(scope, 7, SimpleNamespace(), "second")
    second_task = reflection_jobs._LOCAL_IDLE_SNAPSHOT_TASKS[f"{scope.prefix}:7"]
    await real_sleep(0)
    await asyncio.gather(first_task, return_exceptions=True)
    marker = reflection_jobs._local_idle_snapshot_marker(scope)
    current_token = redis.values[marker]
    assert started[1].is_set()
    assert marker not in redis.deleted
    assert redis.values[marker] == current_token

    idle_gates[1].set()
    await asyncio.wait_for(second_task, timeout=1)
    assert drain_called == ["second"]
    assert marker not in redis.values


@pytest.mark.asyncio
async def test_group_local_idle_marker_refreshes_during_drain(monkeypatch):
    """反思处理超过接管宽限期时续期标记，完成后只清理自己的标记。"""
    from app.core import redis as redis_module

    real_sleep = asyncio.sleep
    start_idle = asyncio.Event()
    refresh_tick = asyncio.Event()
    drain_started = asyncio.Event()
    finish_drain = asyncio.Event()
    refreshed = asyncio.Event()

    async def controlled_sleep(seconds):
        if seconds == reflection_jobs.IDLE_WINDOW.total_seconds():
            await start_idle.wait()
        elif seconds == reflection_jobs._LOCAL_IDLE_SNAPSHOT_MARKER_REFRESH_SECONDS:
            await refresh_tick.wait()
            refresh_tick.clear()
        else:
            await asyncio.Event().wait()

    class Redis:
        def __init__(self):
            self.values = {}
            self.expiries = []
            self.deleted = []

        async def set(self, key, value, ex):
            self.values[key] = value
            self.expiries.append(ex)
            if ex == reflection_jobs._LOCAL_IDLE_SNAPSHOT_MARKER_REFRESH_SECONDS * 3:
                refreshed.set()
            return True

        async def eval(self, script, numkeys, key, token, *args):
            assert numkeys == 1
            if script == reflection_jobs._REFRESH_LOCAL_IDLE_SNAPSHOT_MARKER_LUA:
                if self.values.get(key) != token:
                    return 0
                self.values[key] = token
                self.expiries.append(int(args[0]))
                if int(args[0]) == reflection_jobs._LOCAL_IDLE_SNAPSHOT_MARKER_REFRESH_SECONDS * 3:
                    refreshed.set()
                return 1
            if script == reflection_jobs._DELETE_LOCAL_IDLE_SNAPSHOT_MARKER_LUA:
                if self.values.get(key) != token:
                    return 0
                self.deleted.append(key)
                self.values.pop(key, None)
                return 1
            raise AssertionError("收到未知 Redis Lua 脚本")

    redis = Redis()
    scope = MemoryScope("owner-synthetic", "qq", "bot-synthetic", "group", "group-drain")
    monkeypatch.setattr(redis_module, "get_redis", lambda: redis)
    monkeypatch.setattr(reflection_jobs, "_async_sleep", controlled_sleep)

    async def drain(_scope, _settings, _snapshot):
        drain_started.set()
        await finish_drain.wait()

    monkeypatch.setattr(reflection_jobs, "_settle_scope_with_snapshot", drain)
    assert await reflection_jobs._arm_local_idle_snapshot(scope, 9, SimpleNamespace(), "snapshot")
    task = reflection_jobs._LOCAL_IDLE_SNAPSHOT_TASKS[f"{scope.prefix}:9"]
    await real_sleep(0)
    start_idle.set()
    await asyncio.wait_for(drain_started.wait(), timeout=1)
    await real_sleep(0)
    refresh_tick.set()
    await asyncio.wait_for(refreshed.wait(), timeout=1)
    assert redis.expiries == [
        int(reflection_jobs.IDLE_WINDOW.total_seconds()) + reflection_jobs._LOCAL_IDLE_SNAPSHOT_MARKER_GRACE_SECONDS,
        reflection_jobs._LOCAL_IDLE_SNAPSHOT_MARKER_REFRESH_SECONDS * 3,
    ]
    assert redis.values[reflection_jobs._local_idle_snapshot_marker(scope)]

    finish_drain.set()
    await asyncio.wait_for(task, timeout=1)
    assert redis.values == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["refresh", "delete"])
async def test_old_idle_snapshot_marker_operation_cannot_mutate_replacement_token(operation):
    """旧心跳续期或清理排队时若新 run 换了 token，原子比较必须保留新标记。"""

    class InterleavedRedis:
        def __init__(self):
            self.values = {"marker": "old-token"}
            self.eval_started = asyncio.Event()
            self.allow_eval = asyncio.Event()
            self.expiries = []

        async def set(self, key, value, ex):
            self.values[key] = value
            self.expiries.append(ex)

        async def eval(self, script, numkeys, key, token, *args):
            assert numkeys == 1
            self.eval_started.set()
            # 模拟旧任务的 Lua 命令到达 Redis 前，新 run 已登记新 token。
            await self.allow_eval.wait()
            if script == reflection_jobs._REFRESH_LOCAL_IDLE_SNAPSHOT_MARKER_LUA:
                if self.values.get(key) != token:
                    return 0
                self.values[key] = token
                self.expiries.append(int(args[0]))
                return 1
            if script == reflection_jobs._DELETE_LOCAL_IDLE_SNAPSHOT_MARKER_LUA:
                if self.values.get(key) != token:
                    return 0
                self.values.pop(key, None)
                return 1
            raise AssertionError("收到未知 Redis Lua 脚本")

    redis = InterleavedRedis()
    if operation == "refresh":
        old_operation = reflection_jobs._refresh_local_idle_snapshot_marker(
            redis, "marker", "old-token"
        )
    else:
        old_operation = reflection_jobs._delete_local_idle_snapshot_marker(
            redis, "marker", "old-token"
        )
    task = asyncio.create_task(old_operation)
    await redis.eval_started.wait()
    await redis.set("marker", "new-token", ex=600)
    redis.allow_eval.set()

    assert await task is False
    assert redis.values["marker"] == "new-token"
    assert redis.expiries == [600]
