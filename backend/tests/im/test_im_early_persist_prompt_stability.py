"""早落库不能改动 provider prompt 的字节——缓存命中全靠这个。

缓存前缀是 ``tools → system → messages``，命中要求逐字一致。IM 群聊的历史里有两处
会随"落库时刻"变化而进入 provider 消息：

1. **顺序**：历史按 ``sent_at`` 排序（= 该消息被本轮处理的时间）。早落库行如果按
   ``created_at``（到达时刻）排，run 期间到达的消息会排到上一条回复**之前**，把前缀
   从中间截断——上一轮那段就缓存不住了。
2. **时间提醒**：每条历史用户消息前面会插入 ``消息时间：YYYY-MM-DD HH:MM``
   （``agent/context/history.py``），它取自 ``sent_at``；两个时刻跨了分钟边界，提醒
   文本就变了，前缀同样从中间截断。

所以 run 消费早落库行时（``_reuse_early_user_rows``），必须把 ``sent_at`` 改写成
"run 落库时刻"——与改动前完全一致。``created_at`` 保留**到达时刻**：它是展示时间
（网页气泡、网页实时排序），改了它，网页顺序会和 QQ 群对不上。

本文件用同一套历史→prompt 组装，把"改动前的库状态"和"改动后的库状态"各跑一遍，
直接比对产物。
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

    # ── 改动后：B 早落库（到达时刻），run 消费时把 sent_at 改写成 run 落库时刻 ──
    new_session = await _make_session(db, user_a, "新行为")
    _add_row(db, new_session, role="user", content="第一条", at=first_at)
    _add_row(db, new_session, role="assistant", content="回话", at=reply_at)
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

    await _reuse_early_user_rows(
        db, session_id=new_session.id, early_ids=[row_id], attach_cards=None,
        batch_key="synthetic-batch",
    )
    await db.commit()
    promoted = (await db.scalars(
        select(ConversationMessage).where(ConversationMessage.id == row_id)
    )).one()
    processing_at = promoted.sent_at

    # ── 改动前：B 由 run 落库，时间戳 = run 落库时刻 ──
    old_session = await _make_session(db, user_a, "旧行为")
    _add_row(db, old_session, role="user", content="第一条", at=first_at)
    _add_row(db, old_session, role="assistant", content="回话", at=reply_at)
    _add_row(db, old_session, role="user", content="第二条", at=processing_at)
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
    _add_row(db, session, role="assistant", content="回话", at=reply_at)
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

    await _reuse_early_user_rows(
        db, session_id=session.id, early_ids=[row_id], attach_cards=None,
        batch_key="synthetic-batch",
    )
    await db.commit()
    promoted = (await db.scalars(
        select(ConversationMessage).where(ConversationMessage.id == row_id)
    )).one()

    # created_at = 到达时刻（展示用）；sent_at = 本轮处理时刻（历史排序用）。
    assert promoted.created_at == arrival_at
    assert promoted.sent_at > reply_at

    # 历史顺序按 sent_at：晚到的消息排在本轮回复之后，上一轮那段前缀不动。
    history = await load_session_history(db, session.id)
    assert [item.content for item in history] == ["第一条", "回话", "第二条"]
