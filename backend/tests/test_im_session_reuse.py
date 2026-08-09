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
    """私聊过滤器按 platform_user_id 隔离，并排除群聊 session。"""
    filters = session_scope_filters(
        ConversationSession, "qq", None, "bot-a", "puid-1"
    )
    assert len(filters) == 4
    assert "platform_user_id" in str(filters[3])
    assert "chat_id IS NULL" in str(filters[2])


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


async def test_trim_session_messages_cleans_attachment_storage(db, user_a, monkeypatch, tmp_path):
    """retention trim 删除旧消息时，也要清理其附件物理对象。"""
    from app.core import chat_attach
    from app.models import ChatAttachment
    from app.services.storage import LocalStorageBackend

    storage = LocalStorageBackend(tmp_path)
    monkeypatch.setattr(chat_attach, "get_storage", lambda: storage)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: storage)

    session = ConversationSession(user_id=user_a.id, title="私聊", source="qq")
    db.add(session)
    await db.flush()
    messages = [ConversationMessage(session_id=session.id, role="user", content=f"消息 {i}")
                for i in range(3)]
    db.add_all(messages)
    await db.flush()
    metas = [await chat_attach.stage(user_a.id, f"a{i}.txt", "txt", "text/plain", b"x")
             for i in range(3)]
    for message, meta in zip(messages, metas):
        await chat_attach.claim_attachments(db, user_a.id, message.id, [meta["attach_id"]])
    await db.commit()

    from agent.im import session as session_mod
    monkeypatch.setattr(session_mod, "MESSAGE_TRIM_THRESHOLD", 2)
    monkeypatch.setattr(session_mod, "MESSAGE_RETENTION_LIMIT", 1)
    await session_mod.trim_session_messages(session.id, limit=1, threshold=2)

    remaining = (await db.execute(
        select(ConversationMessage).where(ConversationMessage.session_id == session.id)
    )).scalars().all()
    assert len(remaining) == 1
    old_rows = (await db.execute(
        select(ChatAttachment).where(ChatAttachment.message_id != remaining[0].id)
    )).scalars().all()
    assert old_rows == []
    assert await storage.exists(metas[2]["storage_key"])
    assert not await storage.exists(metas[0]["storage_key"])
    assert not await storage.exists(metas[1]["storage_key"])


async def test_session_eviction_cleans_attachment_storage(db, user_a, monkeypatch, tmp_path):
    """自动淘汰旧 session 时，也要清理附件物理对象。"""
    from app.core import chat_attach
    from app.models import ChatAttachment
    from app.services.storage import LocalStorageBackend

    storage = LocalStorageBackend(tmp_path)
    monkeypatch.setattr(chat_attach, "get_storage", lambda: storage)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: storage)

    oldest = ConversationSession(
        user_id=user_a.id,
        title="旧",
        source="qq",
        bot_id="bot-a",
        platform_user_id="old-peer",
        chat_type="c2c",
    )
    db.add(oldest)
    await db.flush()
    old_message = ConversationMessage(session_id=oldest.id, role="user", content="旧消息")
    db.add(old_message)
    await db.flush()
    old_meta = await chat_attach.stage(user_a.id, "old.txt", "txt", "text/plain", b"old")
    await chat_attach.claim_attachments(db, user_a.id, old_message.id, [old_meta["attach_id"]])
    await db.commit()

    created = await get_or_create_session(
        db, _private_request(user_a.id, "new-peer"), user_a.id, max_sessions=1
    )
    assert created.is_new is True
    assert (await db.execute(
        select(ConversationSession).where(
            ConversationSession.user_id == user_a.id,
            ConversationSession.platform_user_id == "old-peer",
        )
    )).scalars().first() is None
    assert (await db.execute(
        select(ConversationMessage).where(ConversationMessage.content == "旧消息")
    )).scalars().first() is None
    assert (await db.execute(select(ChatAttachment).where(
        ChatAttachment.attach_id == old_meta["attach_id"]
    ))).scalars().first() is None
    assert not await storage.exists(old_meta["storage_key"])


async def test_group_session_platform_user_id_is_null(db, user_a):
    """群聊 session 的 platform_user_id 应为 NULL（群聊用 chat_id 隔离）。"""
    group = await get_or_create_session(
        db, _group_request(user_a.id, "group-1"), user_a.id
    )
    assert group.session.chat_id == "group-1"
    assert group.session.platform_user_id is None


async def test_private_does_not_reuse_group_session(db, user_a):
    """群成员私聊时，不匹配到群聊 session（回归：私聊被并入群消息）。"""
    # 先建一个群聊 session，群成员 puid 为 "member-1"
    group = await get_or_create_session(
        db, _group_request(user_a.id, "group-1"), user_a.id
    )
    # 同一群成员私聊咕咕，puid 相同
    private = await get_or_create_session(
        db, _private_request(user_a.id, "member-1"), user_a.id
    )
    assert private.session.id != group.session.id
    assert private.session.chat_id is None
    assert private.session.platform_user_id == "member-1"
