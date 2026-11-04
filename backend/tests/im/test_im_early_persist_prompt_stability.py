"""早落库的群消息在下一 Run 中仍须保持正确的持久化顺序与提示词时间。

群消息到达时先写入 pending 行，获得会话序号；Run 消费后行改为已处理，但保留序号。
如果只用 Run 开始前读出的历史并把批次追加到尾部，上一轮稍后完成的助手回复会错误地
排在这些群消息之前。本测试确保消费后重载历史，并在 Provider 组装时不重复追加批次。

``created_at`` 保留平台到达时刻用于展示，消息时间标签优先使用平台发送时间，再回落到
事件到达时间；``sent_at`` 可更新为处理时刻，不负责决定该场景的顺序。
"""
from __future__ import annotations

from datetime import timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from agent.context.history import build_history_parts
from agent.context.session_history import load_session_history
from agent.im.early_persist import persist_early_im_message
from agent.run.preparation import _reuse_early_user_rows
from app.core.tz import now_utc
from app.models import ConversationMessage, ConversationSession


def _group_payload(*, owner_user_id: str, message_id: str, text: str) -> dict:
    return {
        "platform": "qq",
        "bot_id": "bot-synthetic",
        "channel_id": "bot-synthetic",
        "message_id": message_id,
        "chat_id": "group-synthetic",
        "chat_type": "group",
        "platform_user_id": "member-synthetic",
        "platform_user_name": "小北",
        "owner_user_id": owner_user_id,
        "text": text,
        "group_mentioned": True,
    }


async def _make_session(db, user_a, title: str) -> ConversationSession:
    session = ConversationSession(
        user_id=user_a.id, title=title, source="qq",
        bot_id="bot-synthetic", chat_id="group-synthetic", chat_type="group",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


def _add_row(db, session, *, role: str, content: str, at) -> ConversationMessage:
    row = ConversationMessage(
        session_id=session.id, role=role, content=content, created_at=at, sent_at=at,
    )
    db.add(row)
    return row


async def _provider_parts(db, session_id: int) -> list[dict]:
    history = await load_session_history(db, session_id)
    return build_history_parts(
        history, SimpleNamespace(chat_id=None),
        use_anthropic=True, user_tz=timezone.utc,
    )


@pytest.mark.asyncio
async def test_prompt_bytes_match_the_pre_early_persist_behaviour(db, user_a):
    """同一段对话，早落库前后生成的 provider 消息必须逐字相同。"""
    now = now_utc()
    # 上一轮：用户问 A（now-5min），咕咕在 now-4min 回话。
    first_at = now - timedelta(minutes=5)
    reply_at = now - timedelta(minutes=4)
    # 本轮：用户在上一轮 run 还在跑的时候发了 B（落在 A 与回话之间）。
    arrival_at = now - timedelta(minutes=4, seconds=30)

    # B 在上一轮回复完成前早落库；消费后仍必须排在该回复之前。
    new_session = await _make_session(db, user_a, "新行为")
    _add_row(db, new_session, role="user", content="第一条", at=first_at)
    await db.commit()

    payload = _group_payload(
        owner_user_id=str(user_a.id), message_id="msg-prompt-1", text="第二条",
    )
    row_id = await persist_early_im_message(payload, message_id="msg-prompt-1")
    assert row_id is not None
    early_row = (await db.scalars(
        select(ConversationMessage).where(ConversationMessage.id == row_id)
    )).one()
    # 模拟"消息是在 run 跑到一半时到的"：到达时刻早于上一轮的回话时刻。
    early_row.created_at = arrival_at
    early_row.sent_at = arrival_at
    await db.commit()
    _add_row(db, new_session, role="assistant", content="回话", at=reply_at)
    await db.commit()

    await _reuse_early_user_rows(
        db, session_id=new_session.id, early_ids=[row_id], attach_cards=None,
        batch_key="synthetic-batch",
    )
    await db.commit()
    promoted = (await db.scalars(
        select(ConversationMessage).where(ConversationMessage.id == row_id)
    )).one()
    processing_at = promoted.sent_at

    # 对照同一实际到达顺序：群消息在上一轮助手回复之前。
    old_session = await _make_session(db, user_a, "旧行为")
    _add_row(db, old_session, role="user", content="第一条", at=first_at)
    old_user = _add_row(db, old_session, role="user", content="第二条", at=arrival_at)
    old_user.sent_at = processing_at
    _add_row(db, old_session, role="assistant", content="回话", at=reply_at)
    await db.commit()
    old_parts = await _provider_parts(db, old_session.id)

    new_parts = await _provider_parts(db, new_session.id)

    assert new_parts == old_parts


@pytest.mark.asyncio
async def test_early_row_keeps_arrival_time_for_display(db, user_a):
    """展示时间保留到达时刻：网页气泡的时间和顺序要和群里的真实先后一致。"""
    now = now_utc()
    first_at = now - timedelta(minutes=5)
    reply_at = now - timedelta(minutes=4)
    arrival_at = now - timedelta(minutes=4, seconds=30)

    session = await _make_session(db, user_a, "展示时间")
    _add_row(db, session, role="user", content="第一条", at=first_at)
    await db.commit()

    payload = _group_payload(
        owner_user_id=str(user_a.id), message_id="msg-arrival-1", text="第二条",
    )
    row_id = await persist_early_im_message(payload, message_id="msg-arrival-1")
    early_row = (await db.scalars(
        select(ConversationMessage).where(ConversationMessage.id == row_id)
    )).one()
    early_row.created_at = arrival_at
    early_row.sent_at = arrival_at
    await db.commit()
    _add_row(db, session, role="assistant", content="回话", at=reply_at)
    await db.commit()

    await _reuse_early_user_rows(
        db, session_id=session.id, early_ids=[row_id], attach_cards=None,
        batch_key="synthetic-batch",
    )
    await db.commit()
    promoted = (await db.scalars(
        select(ConversationMessage).where(ConversationMessage.id == row_id)
    )).one()

    # created_at 保留到达时刻；消费后历史行仍依持久会话顺序排在助手回复之前。
    assert promoted.created_at == arrival_at
    assert promoted.sent_at > reply_at

    # 按消息实际到达时间排序；后续消费时写入的 sent_at 不能改变它与回复的顺序。
    history = await load_session_history(db, session.id)
    assert [item.content for item in history] == ["第一条", "第二条", "回话"]
