"""IM 会话复用与消息窗口裁剪（PRD-IM-6）的单元测试。"""

from sqlalchemy import func, select

from agent.im.session import (
    get_or_create_session,
    session_scope_filters,
    trim_session_messages,
)
from agent.models import AgentRequest
from app.models import ConversationMessage, ConversationSession


def _private_request(user_id, puid, bot_id="bot-a", message="你好"):
    """构造一个私聊 AgentRequest。"""
    return AgentRequest(
        message=message,
        user_id=user_id,
        user_name="用户",
        source="qq",
        platform_bot_id=bot_id,
        platform_user_id=puid,
        chat_id=None,
    )


def _group_request(user_id, chat_id, bot_id="bot-a", message="你好"):
    """构造一个群聊 AgentRequest。"""
    return AgentRequest(
        message=message,
        user_id=user_id,
        user_name="群友",
        source="qq",
        platform_bot_id=bot_id,
        chat_id=chat_id,
    )


async def test_private_session_reused_for_same_peer(db, user_a):
    """同一 (source, bot_id, platform_user_id) 的私聊复用同一 session。"""
    first = await get_or_create_session(
        db, _private_request(user_a.id, "puid-1"), user_a.id
    )
    second = await get_or_create_session(
        db, _private_request(user_a.id, "puid-1"), user_a.id
    )
    assert first.session.id == second.session.id
    assert first.is_new is True
    assert second.is_new is False


async def test_private_sessions_isolated_by_platform_user_id(db, user_a):
    """不同 platform_user_id 的私聊不串用 session。"""
    first = await get_or_create_session(
        db, _private_request(user_a.id, "puid-1"), user_a.id
    )
    second = await get_or_create_session(
        db, _private_request(user_a.id, "puid-2"), user_a.id
    )
    assert first.session.id != second.session.id


async def test_private_sessions_isolated_by_bot_id(db, user_a):
    """同一私聊对象、不同 bot 不串用 session。"""
    first = await get_or_create_session(
        db, _private_request(user_a.id, "puid-1", bot_id="bot-a"), user_a.id
    )
    second = await get_or_create_session(
        db, _private_request(user_a.id, "puid-1", bot_id="bot-b"), user_a.id
    )
    assert first.session.id != second.session.id


async def test_group_session_reused_for_same_chat(db, user_a):
    """同一 (source, bot_id, chat_id) 的群聊复用同一 session。"""
    first = await get_or_create_session(
        db, _group_request(user_a.id, "group-1"), user_a.id
    )
    second = await get_or_create_session(
        db, _group_request(user_a.id, "group-1"), user_a.id
    )
    assert first.session.id == second.session.id
    assert first.is_new is True
    assert second.is_new is False


async def test_web_session_not_reused_by_scope(db, user_a):
    """Web 会话不参与作用域复用，仍按显式 session_id 查找。"""
    from agent.models import AgentRequest

    req = AgentRequest(
        message="你好", user_id=user_a.id, user_name="用户", source="web"
    )
    first = await get_or_create_session(db, req, user_a.id)
    second = await get_or_create_session(db, req, user_a.id)
    # Web 无 session_id 且 source 不在 IM_SOURCES → 每次都新建
    assert first.session.id != second.session.id


def test_session_scope_filters_private_uses_platform_user_id():
    """私聊过滤器按 platform_user_id 隔离，而非 chat_id IS NULL。"""
    filters = session_scope_filters(
        ConversationSession, "qq", None, "bot-a", "puid-1"
    )
    assert len(filters) == 3
    assert "platform_user_id" in str(filters[2])
    assert "chat_id IS NULL" not in str(filters[2])


def test_session_scope_filters_group_uses_chat_id():
    """群聊过滤器仍按 chat_id 隔离。"""
    filters = session_scope_filters(ConversationSession, "qq", "group-1", "bot-a")
    assert len(filters) == 3
    assert "chat_id" in str(filters[2])


async def test_trim_session_messages_skips_below_threshold(db, user_a):
    """消息数未超过阈值时不执行裁剪。"""
    session = ConversationSession(user_id=user_a.id, title="私聊", source="qq")
    db.add(session)
    await db.flush()
    db.add_all([
        ConversationMessage(session_id=session.id, role="user", content=f"消息 {index}")
        for index in range(550)
    ])
    await db.commit()

    await trim_session_messages(session.id)

    count = await db.scalar(
        select(func.count()).select_from(ConversationMessage).where(
            ConversationMessage.session_id == session.id,
        )
    )
    assert count == 550


async def test_trim_session_messages_trims_above_threshold(db, user_a):
    """消息数超过阈值时裁剪到保留上限。"""
    session = ConversationSession(user_id=user_a.id, title="私聊", source="qq")
    db.add(session)
    await db.flush()
    db.add_all([
        ConversationMessage(session_id=session.id, role="user", content=f"消息 {index}")
        for index in range(605)
    ])
    await db.commit()

    await trim_session_messages(session.id)

    count = await db.scalar(
        select(func.count()).select_from(ConversationMessage).where(
            ConversationMessage.session_id == session.id,
        )
    )
    assert count == 500
