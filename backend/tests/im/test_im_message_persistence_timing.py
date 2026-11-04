"""IM 消息落库时机：会话 run 占用锁期间到达的消息也必须立即入库。

背景
----
普通群消息走「防抖缓冲 → 会话锁 → 完整 run」，落库曾经是 run 的
副产品（run 准备阶段才写 ``user_message`` 行）。于是同一会话 run 进行中到达的消息
既不入库、也不推到前端，积压后只能逐条补记——这正是「咕咕跑的时候群里消息看不到、
恢复很慢」的成因。

现在的行为
----------
IM 消息在 ``worker._dispatch`` 阶段就早落库（``agent.im/early_persist.py``），不等
当前 run 跑完：消息立刻写入 ``conversation_messages`` 并发布 ``sessions`` 增量事件。
run 起来时**复用**那一行（``agent/run/preparation.py::_reuse_early_user_rows``），
所以库里不会出现第二条 user 行。

用例只断言可观察状态（库里有没有这条消息、前端事件有没有发），不绑定落库发生在
哪个函数里。
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import fakeredis.aioredis
import pytest
from sqlalchemy import select

from app.models import ConversationMessage, ConversationSession


def _group_payload(*, owner_user_id: str, message_id: str, text: str) -> dict:
    """一条群消息的网关 payload（纯合成数据，不接任何平台实现）。"""
    return {
        "platform": "qq",
        "bot_id": "bot-synthetic",
        "channel_id": "bot-synthetic",
        "platform_bot_user_id": "bot-openid-synthetic",
        "message_id": message_id,
        "chat_id": "group-synthetic",
        "chat_type": "group",
        "platform_user_id": "member-synthetic",
        "platform_user_name": "小北",
        "owner_user_id": owner_user_id,
        "user_id": owner_user_id,
        "user_name": "小北",
        "text": text,
        "group_mentioned": False,
    }


async def _make_group_session(db, user_a) -> ConversationSession:
    session = ConversationSession(
        user_id=user_a.id, title="合成群", source="qq",
        bot_id="bot-synthetic", chat_id="group-synthetic", chat_type="group",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


async def _make_private_session(db, user_a) -> ConversationSession:
    session = ConversationSession(
        user_id=user_a.id, title="合成私聊", source="qq", bot_id="bot-synthetic",
        platform_user_id="member-synthetic", chat_type="c2c",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


def _private_payload(*, owner_user_id: str, message_id: str, text: str) -> dict:
    return {
        "platform": "qq",
        "bot_id": "bot-synthetic",
        "channel_id": "bot-synthetic",
        "platform_bot_user_id": "bot-openid-synthetic",
        "message_id": message_id,
        "chat_type": "c2c",
        "platform_user_id": "member-synthetic",
        "platform_user_name": "小北",
        "owner_user_id": owner_user_id,
        "user_id": owner_user_id,
        "text": text,
    }


def _silence_group_memory(monkeypatch) -> None:
    """群记忆/反思是旁路，不该影响「消息是否落库」这条断言。"""
    monkeypatch.setattr(
        "agent.memory.reflection_jobs.observe_group_message", AsyncMock(return_value=None)
    )
    monkeypatch.setattr(
        "agent.memory.group_pressure.observe_passive_context_pressure",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr("agent.memory.reflection.schedule", lambda *a, **k: None)
    monkeypatch.setattr("agent.memory.reflection.flush_group_owner_buffer", lambda *a, **k: None)


@pytest.mark.asyncio
async def test_reply_all_group_message_is_persisted_while_session_lock_is_held(db, user_a, monkeypatch):
    """全量回复模式：同群 run 占着会话锁时，新到的群消息仍然立即落库并推送。"""
    import worker
    from agent.im.session import ImConversationKey
    from app.db import session as db_session

    session = await _make_group_session(db, user_a)
    session_id = session.id
    # 内存库靠 StaticPool 共享同一条连接：fixture 的会话先释放连接，worker 侧
    # 再开自己的会话查库时才不会撞上「同一条连接两个会话」。断言也用独立会话查。
    await db.close()

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(worker.R, "get_redis", lambda: redis)
    monkeypatch.setattr(worker.R, "ack", AsyncMock())
    # 全量回复模式：group_requires_at=False → group_read_enabled 同样是 False，
    # 普通群消息既不是「静默记录」也不是「明确 @」，必须靠落库时机而不是模式来保时效。
    monkeypatch.setattr(
        "agent.im.permissions.resolve_group_policy",
        AsyncMock(return_value=(True, False, False, True, True)),
    )
    # 这条消息最终仍要进 run 做回复决策；本用例只断言「落库不依赖 run 启动」。
    monkeypatch.setattr(worker, "handle", AsyncMock())
    published: list[tuple[str, dict]] = []

    async def publish(_user_id, resource, **kwargs):
        published.append((resource, kwargs))
        return True

    monkeypatch.setattr("app.core.events.publish", publish)
    _silence_group_memory(monkeypatch)

    payload = _group_payload(
        owner_user_id=str(user_a.id), message_id="msg-early-1", text="群里随便一句话"
    )
    key = ImConversationKey("qq", "bot-synthetic", "group", "group-synthetic")
    lock = worker._user_locks.setdefault(key, asyncio.Lock())
    await lock.acquire()          # 模拟同群 run 正在执行、会话锁被占
    try:
        await worker._dispatch("msg-early-1", payload)

        async with db_session._SessionLocal() as loaded:
            rows = (await loaded.scalars(
                select(ConversationMessage).where(ConversationMessage.session_id == session_id)
            )).all()
        assert [row.content for row in rows] == ["群里随便一句话"]
        assert [resource for resource, _ in published] == ["sessions"]
    finally:
        lock.release()
        worker._user_locks.pop(key, None)
        pending = worker._user_flush.pop(key, None)
        if pending is not None:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        worker._user_buffers.pop(key, None)
        worker._user_deadline.pop(key, None)
        worker._buffered_message_ids.discard("msg-early-1")
        worker._pending_message_ids.discard("msg-early-1")
        worker._stop_message_lease("msg-early-1")
        await redis.aclose()


@pytest.mark.asyncio
async def test_passive_group_recording_publishes_session_increment(db, user_a, monkeypatch):
    """被动消息落库必须同时发布 sessions 增量事件——网页实时可见的唯一通道。"""
    from types import SimpleNamespace

    from agent.im import conversation
    from app.db import session as db_session

    published: list[tuple[str, dict]] = []

    async def publish(_user_id, resource, **kwargs):
        published.append((resource, kwargs))
        return True

    monkeypatch.setattr("app.core.events.publish", publish)
    _silence_group_memory(monkeypatch)

    request = SimpleNamespace(
        attachments=[], user_id=user_a.id, source="qq", platform_bot_id="bot-synthetic",
        chat_id="group-synthetic", platform_user_id="member-synthetic", platform_user_name="小北",
        platform_bot_user_id=None, message="群里一句话", quoted_text=None,
        im_group_memory_enabled=True, im_role="member", user_name="小北",
    )
    session_id = await conversation.record_passive_im_message(request)

    async with db_session._SessionLocal() as loaded:
        rows = (await loaded.scalars(
            select(ConversationMessage).where(ConversationMessage.session_id == session_id)
        )).all()
    assert [row.content for row in rows] == ["群里一句话"]
    assert [resource for resource, _ in published] == ["sessions"]
    assert published[0][1]["session_id"] == session_id
    assert published[0][1]["appended"][0]["text"] == "群里一句话"


@pytest.mark.asyncio
async def test_private_message_is_persisted_while_session_lock_is_held(db, user_a, monkeypatch):
    """私聊 run 占着会话锁期间，新消息仍先入库并推送。"""
    import worker
    from agent.im.session import ImConversationKey
    from app.db import session as db_session

    session = await _make_private_session(db, user_a)
    session_id = session.id
    await db.close()

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(worker.R, "get_redis", lambda: redis)
    monkeypatch.setattr(worker, "_claim_message", AsyncMock(return_value="claimed"))
    monkeypatch.setattr(worker, "handle", AsyncMock())
    monkeypatch.setattr("agent.im.interaction_text.has_active_interaction", AsyncMock(return_value=False))
    published: list[tuple[str, dict]] = []

    async def publish(_user_id, resource, **kwargs):
        published.append((resource, kwargs))
        return True

    monkeypatch.setattr("app.core.events.publish", publish)
    payload = _private_payload(
        owner_user_id=str(user_a.id), message_id="msg-private-live", text="私聊排队消息",
    )
    key = ImConversationKey("qq", "bot-synthetic", "c2c", "member-synthetic")
    lock = worker._user_locks.setdefault(key, asyncio.Lock())
    await lock.acquire()
    try:
        await worker._dispatch("msg-private-live", payload)
        async with db_session._SessionLocal() as loaded:
            rows = (await loaded.scalars(
                select(ConversationMessage).where(ConversationMessage.session_id == session_id)
            )).all()
        assert [(row.content, row.chat_type) for row in rows] == [("私聊排队消息", "c2c")]
        assert [resource for resource, _ in published] == ["sessions"]
    finally:
        lock.release()
        worker._user_locks.pop(key, None)
        pending = worker._user_flush.pop(key, None)
        if pending is not None:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        worker._user_buffers.pop(key, None)
        worker._user_deadline.pop(key, None)
        worker._buffered_message_ids.discard("msg-private-live")
        worker._pending_message_ids.discard("msg-private-live")
        await redis.aclose()


@pytest.mark.asyncio
async def test_worker_consumes_mcp_secret_before_persistence_or_session_event(db, user_a, monkeypatch):
    """凭据交互从 Worker 入口短路，秘密正文不得落库或发布到聊天 SSE。"""
    import worker
    from app.db import session as db_session

    session = await _make_private_session(db, user_a)
    session_id = session.id
    await db.close()

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(worker.R, "get_redis", lambda: redis)
    monkeypatch.setattr(worker, "_claim_message", AsyncMock(return_value="claimed"))
    monkeypatch.setattr(worker, "_ack_inbound", AsyncMock())
    monkeypatch.setattr("agent.im.interaction_text.has_active_interaction", AsyncMock(return_value=False))

    consumed = []

    async def consume_secret(payload):
        consumed.append(payload["text"])
        return True

    monkeypatch.setattr("agent.im.interaction_text.consume_mcp_secret_payload", consume_secret)
    appended_events = []

    async def publish(_user_id, resource, **kwargs):
        if resource == "sessions":
            appended_events.extend(kwargs.get("appended") or [])
        return True

    monkeypatch.setattr("app.core.events.publish", publish)
    secret = "synthetic-mcp-secret-value"
    payload = _private_payload(
        owner_user_id=str(user_a.id), message_id="secret-event-1", text=secret,
    )

    await worker._dispatch("secret-event-1", payload)

    async with db_session._SessionLocal() as loaded:
        rows = (await loaded.scalars(
            select(ConversationMessage).where(ConversationMessage.session_id == session_id)
        )).all()
    assert consumed == [secret]
    assert all(secret not in row.content for row in rows)
    assert all(secret not in str(event) for event in appended_events)
    assert appended_events == []
    worker._user_buffers.clear()
    worker._user_deadline.clear()
    await redis.aclose()
