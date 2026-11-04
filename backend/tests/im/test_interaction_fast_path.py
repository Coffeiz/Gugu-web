"""交互快速通道：网关 owner_user_id 是字符串时也必须命中活动交互。

背景
----
ask_user 等待期间，首轮 Run 会持有会话锁；交互回复（数字/选项）必须绕过这把锁
直接唤醒原 Run，否则只能排在正在等待的 Run 后面，直到 Prompt 超时。

Worker 判定「这是不是交互回复」时，把网关 payload 里的 owner_user_id 原样传进
``has_active_interaction``。网关传的是字符串（各平台 owner 来自环境变量），而
``InteractionRequest.user_id`` 是 UUID 列：直接比较会在 SQL 绑定阶段抛
``'str' object has no attribute 'hex'``，异常被 worker 吞掉 → 快速通道从未生效，
交互回复被当成普通消息排队。

用例只断言可观察行为（交互是否被识别、是否绕过会话锁），不绑定实现写法。
"""
from __future__ import annotations

import asyncio
from datetime import timedelta
from unittest.mock import AsyncMock

import fakeredis.aioredis
import pytest

from app.core.tz import now_utc
from app.models import ConversationSession, InteractionRequest


PRIVATE_BOT_ID = "bot-synthetic"
PRIVATE_SPEAKER = "member-synthetic"


def _private_payload(*, owner_user_id: str, message_id: str, text: str) -> dict:
    """一条私聊消息的网关 payload（纯合成数据，不接任何平台实现）。"""
    return {
        "platform": "qq",
        "bot_id": PRIVATE_BOT_ID,
        "channel_id": PRIVATE_BOT_ID,
        "platform_bot_user_id": "bot-openid-synthetic",
        "message_id": message_id,
        "chat_type": "c2c",
        "platform_user_id": PRIVATE_SPEAKER,
        "platform_user_name": "小北",
        "owner_user_id": owner_user_id,
        "user_id": owner_user_id,
        "user_name": "小北",
        "text": text,
    }


async def _make_private_session(db, user_a, *, expires_in: timedelta = timedelta(minutes=10)):
    """建一个私聊 IM 会话，并在其上挂一条活动中的交互请求。"""
    session = ConversationSession(
        user_id=user_a.id, title="合成私聊", source="qq",
        bot_id=PRIVATE_BOT_ID, chat_id=None, chat_type="c2c",
        platform_user_id=PRIVATE_SPEAKER,
    )
    db.add(session)
    await db.flush()
    prompt = InteractionRequest(
        user_id=user_a.id, session_id=session.id, kind="choice",
        title="选一个方案", body="",
        schema_json={"options": [{"id": "a", "label": "方案 A"}]},
        status="active", expires_at=now_utc() + expires_in,
    )
    db.add(prompt)
    await db.commit()
    return session, prompt


@pytest.mark.asyncio
async def test_has_active_interaction_accepts_string_owner_user_id(db, user_a):
    """网关 owner_user_id 是字符串时也必须命中活动交互。"""
    from agent.im.interaction_text import has_active_interaction

    await _make_private_session(db, user_a)
    # 内存库靠 StaticPool 共享同一条连接：fixture 的会话先释放连接，
    # 被测代码再开自己的会话查库时才不会撞上「同一条连接两个会话」。
    await db.close()

    assert await has_active_interaction(
        user_id=str(user_a.id),
        platform="qq",
        bot_id=PRIVATE_BOT_ID,
        chat_id=None,
        platform_user_id=PRIVATE_SPEAKER,
    ) is True


@pytest.mark.asyncio
async def test_has_active_interaction_accepts_uuid_owner_user_id(db, user_a):
    """已经是 UUID 的归属键同样要命中——归一化不能把正常路径弄坏。"""
    from agent.im.interaction_text import has_active_interaction

    await _make_private_session(db, user_a)
    await db.close()

    assert await has_active_interaction(
        user_id=user_a.id,
        platform="qq",
        bot_id=PRIVATE_BOT_ID,
        chat_id=None,
        platform_user_id=PRIVATE_SPEAKER,
    ) is True


@pytest.mark.asyncio
async def test_has_active_interaction_ignores_expired_interaction(db, user_a):
    """过期交互不算活动交互，不能放行交互快速通道。"""
    from agent.im.interaction_text import has_active_interaction

    await _make_private_session(db, user_a, expires_in=timedelta(minutes=-5))
    await db.close()

    assert await has_active_interaction(
        user_id=str(user_a.id),
        platform="qq",
        bot_id=PRIVATE_BOT_ID,
        chat_id=None,
        platform_user_id=PRIVATE_SPEAKER,
    ) is False


@pytest.mark.asyncio
async def test_has_active_interaction_rejects_malformed_owner_user_id(db, user_a):
    """归属键根本不是 UUID 时按「没有活动交互」处理，不能抛异常打断派发。"""
    from agent.im.interaction_text import has_active_interaction

    await _make_private_session(db, user_a)
    await db.close()

    assert await has_active_interaction(
        user_id="not-a-uuid",
        platform="qq",
        bot_id=PRIVATE_BOT_ID,
        chat_id=None,
        platform_user_id=PRIVATE_SPEAKER,
    ) is False


@pytest.mark.asyncio
async def test_interaction_reply_bypasses_session_lock(db, user_a, monkeypatch):
    """有活动交互时回复必须立刻被处理——即使同会话的 Run 正占着会话锁。"""
    import worker
    from agent.im.session import ImConversationKey

    await _make_private_session(db, user_a)
    await db.close()

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(worker.R, "get_redis", lambda: redis)
    monkeypatch.setattr(worker.R, "ack", AsyncMock())
    handled: list[str] = []

    async def handle(msg_id, _payload):
        handled.append(msg_id)

    monkeypatch.setattr(worker, "handle", handle)

    key = ImConversationKey("qq", PRIVATE_BOT_ID, "c2c", PRIVATE_SPEAKER)
    lock = worker._user_locks.setdefault(key, asyncio.Lock())
    await lock.acquire()          # 模拟同会话 Run 正在执行、会话锁被占
    try:
        await worker._dispatch("msg-interaction-1", _private_payload(
            owner_user_id=str(user_a.id), message_id="msg-interaction-1", text="1",
        ))
        assert handled == ["msg-interaction-1"]
        # 交互回复不能再进防抖缓冲：否则会排在正在等待的 Run 后面直到 Prompt 超时。
        assert key not in worker._user_buffers
    finally:
        lock.release()
        worker._user_locks.pop(key, None)
        worker._stop_message_lease("msg-interaction-1")
        await redis.aclose()
