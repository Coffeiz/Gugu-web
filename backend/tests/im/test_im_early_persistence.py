"""IM 消息早落库：消息先入库，run 复用同一行，不产生第二条。

要钉住的行为
------------
1. 要进 run 的 IM 消息在 ``worker._dispatch`` 阶段就写入 ``conversation_messages``，
   不等当前 run 跑完。
2. 早落库行带 ``im-pending:`` 临时 run_id —— 它表示「已入库但还没被任何 run 消费」：
   - run 读历史要排除这类行，否则同一段话在「历史」和「当前轮」各出现一次；
   - 它同时是这条消息的幂等键，重投时复用同一行。
3. run 起来时**复用**那一行并把 run_id 改成批次键（``im-inbound:{batch_key}``），
   库里不能出现第二条 user 行；批次键同时让 ``recover_started`` 保持「这批是否已经
   开始过」的判定不变。
4. 只写**已存在**的会话：建会话留给 run 路径，避免并发创建重复会话。
5. 只记录不回复的群消息不走早落库；私聊和要进 run 的群消息共用同一流程。

用例只断言可观察状态（库里几行、run_id 是什么、历史里有没有），不绑定实现写法。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from agent.im.inbound_recovery import pending_user_run_key, user_run_key
from app.models import ConversationMessage, ConversationSession


def _group_payload(*, owner_user_id: str, message_id: str, text: str, **overrides) -> dict:
    """一条群消息的网关 payload（纯合成数据，不接任何平台实现）。"""
    payload = {
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
        "text": text,
        "group_mentioned": True,
    }
    payload.update(overrides)
    return payload


def _private_payload(*, owner_user_id: str, message_id: str, text: str, **overrides) -> dict:
    payload = {
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
    payload.update(overrides)
    return payload


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


async def _messages(db, session_id: int) -> list[ConversationMessage]:
    return list((await db.scalars(
        select(ConversationMessage).where(ConversationMessage.session_id == session_id)
    )).all())


@pytest.mark.asyncio
async def test_early_persisted_row_is_written_before_any_run(db, user_a):
    """要进 run 的群消息立刻入库，并带「已入库未消费」标记。"""
    from agent.im.early_persist import persist_early_im_message

    session = await _make_group_session(db, user_a)
    payload = _group_payload(
        owner_user_id=str(user_a.id), message_id="msg-early-1", text="群里随便一句话",
    )
    row_id = await persist_early_im_message(payload, message_id="msg-early-1")
    assert row_id is not None

    rows = await _messages(db, session.id)
    assert [row.content for row in rows] == ["群里随便一句话"]
    assert rows[0].run_id == pending_user_run_key("msg-early-1")
    assert rows[0].role == "user"
    assert rows[0].chat_type == "group"


@pytest.mark.asyncio
async def test_redelivered_message_reuses_the_same_early_row(db, user_a):
    """同一条消息被重投时复用同一行，不插第二条。"""
    from agent.im.early_persist import persist_early_im_message

    session = await _make_group_session(db, user_a)
    payload = _group_payload(
        owner_user_id=str(user_a.id), message_id="msg-early-2", text="重复投递的一句话",
    )
    first = await persist_early_im_message(payload, message_id="msg-early-2")
    second = await persist_early_im_message(payload, message_id="msg-early-2")
    assert first == second

    rows = await _messages(db, session.id)
    assert [row.content for row in rows] == ["重复投递的一句话"]


@pytest.mark.asyncio
async def test_early_persist_skips_when_group_session_does_not_exist_yet(db, user_a):
    """群会话还不存在时不早落库——建会话留给 run 路径，避免并发建出两个会话。"""
    from agent.im.early_persist import persist_early_im_message

    payload = _group_payload(
        owner_user_id=str(user_a.id), message_id="msg-early-3", text="新群的第一句",
    )
    assert await persist_early_im_message(payload, message_id="msg-early-3") is None
    rows = (await db.scalars(select(ConversationMessage))).all()
    assert rows == []


@pytest.mark.asyncio
async def test_run_reuses_early_row_and_promotes_it_to_the_batch_key(db, user_a):
    """run 复用早落库行：不新增 user 行，run_id 改成批次键。"""
    from agent.im.early_persist import persist_early_im_message
    from agent.run.preparation import _reuse_early_user_rows

    session = await _make_group_session(db, user_a)
    payload = _group_payload(
        owner_user_id=str(user_a.id), message_id="msg-early-4", text="要被 run 消费的一句",
    )
    row_id = await persist_early_im_message(payload, message_id="msg-early-4")
    assert row_id is not None

    anchor, reused = await _reuse_early_user_rows(
        db, session_id=session.id, early_ids=[row_id], attach_cards=None,
        batch_key="synthetic-batch",
    )
    await db.commit()

    assert anchor is not None
    assert anchor.id == row_id
    assert [row.id for row in reused] == [row_id]
    # 库里仍然只有这一行 user 消息——不能因为早落库又多写一条。
    rows = await _messages(db, session.id)
    assert [row.id for row in rows] == [row_id]
    assert rows[0].run_id == user_run_key("synthetic-batch")


@pytest.mark.asyncio
async def test_run_without_early_row_inserts_a_new_row(db, user_a):
    """没有早落库行时照旧插新行（降级路径不能把消息弄丢）。"""
    from agent.run.preparation import _reuse_early_user_rows

    session = await _make_group_session(db, user_a)

    anchor, reused = await _reuse_early_user_rows(
        db, session_id=session.id, early_ids=[999999], attach_cards=None,
        batch_key="synthetic-batch",
    )
    assert anchor is None
    assert reused == []


async def test_partial_early_persistence_restores_every_message_in_arrival_order(db, user_a):
    """同批部分早落库失败时补齐缺失行，历史顺序和锚点仍按入站顺序。"""
    from agent.run.preparation import _reuse_early_user_rows
    from agent.context.session_history import load_session_history

    session = await _make_group_session(db, user_a)
    later = ConversationMessage(session_id=session.id, role="user", content="第二条",
                                run_id=pending_user_run_key("second"), chat_type="group")
    earlier = ConversationMessage(session_id=session.id, role="user", content="第一条",
                                  run_id=pending_user_run_key("first"), chat_type="group")
    db.add_all([later, earlier])
    await db.commit()
    anchor, rows = await _reuse_early_user_rows(
        db, session_id=session.id, early_ids=[earlier.id, later.id], attach_cards=None,
        batch_key="partial-batch", batch_messages=[
            {"early_id": None, "text": "缺失的先到消息", "platform_user_id": "u3"},
            {"early_id": earlier.id, "text": "第一条", "platform_user_id": "u1"},
            {"early_id": later.id, "text": "第二条", "platform_user_id": "u2"},
        ],
    )
    await db.commit()
    assert [row.content for row in rows] == ["缺失的先到消息", "第一条", "第二条"]
    assert anchor.id == later.id
    assert anchor.id < earlier.id
    assert all(row.run_id == user_run_key("partial-batch") for row in rows)
    history = await load_session_history(db, session.id)
    assert [row.content for row in history] == ["缺失的先到消息", "第一条", "第二条"]


@pytest.mark.asyncio
async def test_pending_row_is_excluded_from_history_until_the_run_consumes_it(db, user_a):
    """早落库行在被 run 消费前不进历史；消费后就进。"""
    from agent.context.session_history import load_session_history
    from agent.im.early_persist import persist_early_im_message
    from agent.run.preparation import _reuse_early_user_rows

    session = await _make_group_session(db, user_a)
    payload = _group_payload(
        owner_user_id=str(user_a.id), message_id="msg-early-5", text="还没被 run 消费的一句",
    )
    row_id = await persist_early_im_message(payload, message_id="msg-early-5")
    assert row_id is not None
    db.add(ConversationMessage(session_id=session.id, role="user", content="上一轮已处理的一句"))
    await db.commit()

    history = await load_session_history(db, session.id)
    assert [row.content for row in history] == ["上一轮已处理的一句"]

    await _reuse_early_user_rows(
        db, session_id=session.id, early_ids=[row_id], attach_cards=None,
        batch_key="synthetic-batch",
    )
    await db.commit()

    history = await load_session_history(db, session.id)
    # 历史按持久序号排序；消费标记变更不会重排已提前入库的消息。
    assert [row.content for row in history] == ["还没被 run 消费的一句", "上一轮已处理的一句"]


@pytest.mark.asyncio
async def test_promoted_row_keeps_sequence_order_after_consumption(db, user_a):
    """消费早落库行只更新处理时间，不改变到达时确定的持久历史顺序。"""
    from datetime import timedelta

    from agent.context.session_history import load_session_history
    from agent.im.early_persist import persist_early_im_message
    from agent.run.preparation import _reuse_early_user_rows
    from app.core.tz import now_utc

    session = await _make_group_session(db, user_a)
    reply = ConversationMessage(
        session_id=session.id, role="assistant", content="上一轮的回话",
        created_at=now_utc() - timedelta(minutes=1),
    )
    db.add(reply)
    await db.commit()

    payload = _group_payload(
        owner_user_id=str(user_a.id), message_id="msg-early-8", text="run 期间到达的一句",
    )
    row_id = await persist_early_im_message(payload, message_id="msg-early-8")
    assert row_id is not None
    early_row = (await db.scalars(
        select(ConversationMessage).where(ConversationMessage.id == row_id)
    )).one()
    arrival_at = now_utc()
    early_row.created_at = arrival_at
    early_row.sent_at = arrival_at
    await db.commit()

    await _reuse_early_user_rows(
        db, session_id=session.id, early_ids=[row_id], attach_cards=None,
        batch_key="synthetic-batch",
    )
    await db.commit()
    await db.refresh(early_row)

    # sent_at 用于提示词时间语义，不参与 canonical history 的顺序判定。
    assert early_row.sent_at >= reply.created_at
    # 展示时间仍是到达时刻。
    assert early_row.created_at == arrival_at
    assert early_row.conversation_seq > reply.conversation_seq
    history = await load_session_history(db, session.id)
    assert [(row.role, row.content) for row in history] == [
        ("assistant", "上一轮的回话"),
        ("user", "run 期间到达的一句"),
    ]


@pytest.mark.asyncio
async def test_passive_group_message_is_not_early_persisted(db, user_a):
    """只记录不回复的群消息不走早落库（它走被动记录路径）。"""
    from agent.im.early_persist import persist_early_im_message

    await _make_group_session(db, user_a)
    payload = _group_payload(
        owner_user_id=str(user_a.id), message_id="msg-early-6", text="只记录的一句话",
        group_read_enabled=True, group_mentioned=False,
    )
    assert await persist_early_im_message(payload, message_id="msg-early-6") is None
    rows = (await db.scalars(select(ConversationMessage))).all()
    assert rows == []


@pytest.mark.asyncio
async def test_telegram_bind_command_is_not_early_persisted(db, user_a):
    """Telegram 绑定控制命令不进入会话历史，避免验证码被写入聊天记录。"""
    from agent.im.early_persist import persist_early_im_message

    await _make_private_session(db, user_a)
    payload = _private_payload(
        owner_user_id=str(user_a.id), message_id="telegram-bind-1",
        text="/bind synthetic-one-time-code", platform="telegram",
        telegram_command="bind",
    )
    assert await persist_early_im_message(payload, message_id="telegram-bind-1") is None
    assert (await db.scalars(select(ConversationMessage))).all() == []


@pytest.mark.asyncio
async def test_private_messages_are_early_persisted_and_reused_as_one_batch(db, user_a):
    """私聊 B、C 各自保留历史行，并由同一 run 批次消费。"""
    from agent.im.early_persist import persist_early_im_message
    from agent.run.preparation import _reuse_early_user_rows

    session = await _make_private_session(db, user_a)
    first_payload = _private_payload(
        owner_user_id=str(user_a.id), message_id="msg-private-1", text="B",
    )
    second_payload = _private_payload(
        owner_user_id=str(user_a.id), message_id="msg-private-2", text="C",
        quoted_text="引用 C",
    )
    first_id = await persist_early_im_message(first_payload, message_id="msg-private-1")
    second_id = await persist_early_im_message(second_payload, message_id="msg-private-2")
    assert first_id is not None and second_id is not None

    anchor, batch_rows = await _reuse_early_user_rows(
        db,
        session_id=session.id,
        early_ids=[first_id, second_id],
        attach_cards=None,
        batch_key="private-batch",
        batch_messages=[
            {"early_id": first_id, "text": "B", "chat_type": "c2c"},
            {"early_id": second_id, "text": "C", "quoted_text": "引用 C", "chat_type": "c2c"},
        ],
    )
    await db.commit()

    rows = await _messages(db, session.id)
    assert [row.content for row in rows] == ["B", "C"]
    assert [row.chat_type for row in rows] == ["c2c", "c2c"]
    assert [row.quoted_text for row in rows] == [None, "引用 C"]
    assert all(row.run_id == user_run_key("private-batch") for row in rows)
    assert [row.id for row in batch_rows] == [first_id, second_id]
    assert anchor.id == second_id


@pytest.mark.asyncio
async def test_batch_attachment_cards_remain_with_their_original_speakers(db, user_a):
    """多人批次消费附件时，每条消息气泡保留自己发言人的附件卡片。"""
    from agent.run.preparation import _reuse_early_user_rows

    session = await _make_group_session(db, user_a)
    first = ConversationMessage(
        session_id=session.id, role="user", content="A 发图",
        platform_user_id="speaker-a", chat_type="group",
    )
    second = ConversationMessage(
        session_id=session.id, role="user", content="B 提问",
        platform_user_id="speaker-b", chat_type="group",
    )
    db.add_all([first, second])
    await db.flush()
    card_a = {"attach_id": "attachment-a", "name": "a.png", "kind": "image"}
    card_b = {"attach_id": "attachment-b", "name": "b.png", "kind": "image"}

    anchor, rows = await _reuse_early_user_rows(
        db,
        session_id=session.id,
        early_ids=[first.id, second.id],
        attach_cards=[card_a, card_b],
        batch_key="group-attachment-batch",
        batch_messages=[
            {"early_id": first.id, "text": "A 发图", "attachments": ["attachment-a"]},
            {"early_id": second.id, "text": "B 提问", "attachments": ["attachment-b"]},
        ],
    )
    await db.commit()

    assert anchor.id == second.id
    assert rows[0].files == [card_a]
    assert rows[1].files == [card_b]


async def test_first_private_batch_without_existing_session_is_persisted_by_run(db, user_a):
    """私聊新会话不提前建 session，run 准备阶段仍逐条写入整批消息。"""
    from agent.im.early_persist import persist_early_im_message
    from agent.run.preparation import _reuse_early_user_rows

    payload = _private_payload(
        owner_user_id=str(user_a.id), message_id="msg-private-first", text="首次私聊",
    )
    assert await persist_early_im_message(payload, message_id="msg-private-first") is None

    session = ConversationSession(
        user_id=user_a.id, title="新私聊", source="qq", bot_id="bot-synthetic",
        platform_user_id="member-synthetic", chat_type="c2c",
    )
    db.add(session)
    await db.flush()
    anchor, rows = await _reuse_early_user_rows(
        db,
        session_id=session.id,
        early_ids=[],
        attach_cards=None,
        batch_key="first-private-batch",
        batch_messages=[
            {"text": "B", "chat_type": "c2c", "platform_user_id": "member-synthetic"},
            {"text": "C", "chat_type": "c2c", "platform_user_id": "member-synthetic"},
        ],
    )
    await db.commit()
    assert [row.content for row in rows] == ["B", "C"]
    assert all(row.chat_type == "c2c" for row in rows)
    assert all(row.run_id == user_run_key("first-private-batch") for row in rows)
    assert anchor.id == rows[-1].id
