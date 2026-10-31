"""PASSIVE 注意力批次事务提交后可安全 ACK 和重投。"""
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from agent.im.auto_reply.attention import AttentionDecision, AttentionKind
from agent.im.inbound_recovery import recover_started, user_run_key
from app.models import ConversationBatch, ConversationMessage, ConversationSession


@pytest.mark.asyncio
async def test_passive_attention_batch_persists_each_event_and_recovers_after_commit(
    db, user_a, monkeypatch,
):
    from agent.im import conversation
    import app.db.session as db_session

    async def no_trim(_session_id):
        return None

    monkeypatch.setattr(conversation, "trim_session_messages", no_trim)
    published = []

    async def publish(_user_id, _resource, **payload):
        published.append(payload)

    from app.core import events
    monkeypatch.setattr(events, "publish", publish)

    session = ConversationSession(
        user_id=user_a.id, title="合成群", source="qq", bot_id="bot-synthetic",
        chat_id="group-synthetic", chat_type="group",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    session_id = session.id
    request = SimpleNamespace(
        user_id=user_a.id, source="qq", platform_bot_id="bot-synthetic",
        chat_id="group-synthetic", im_group_memory_enabled=False,
    )
    messages = [
        {
            "event_id": "1761746400000-0", "early_id": None, "text": "消息甲",
            "platform_user_id": "member-a", "platform_user_name": "小北",
            "platform_bot_user_id": "bot-openid", "chat_type": "group", "attachments": [],
        },
        {
            "event_id": "1761746401000-0", "early_id": None, "text": "消息乙",
            "platform_user_id": "member-b", "platform_user_name": "小南",
            "platform_bot_user_id": "bot-openid", "chat_type": "group", "attachments": [],
        },
    ]

    await conversation.record_passive_attention_batch(
        request, messages, session_id=session.id, batch_key="synthetic-batch",
        attention_decision=AttentionDecision(
            AttentionKind.PASSIVE, 0, 70, ("snapshot_incomplete",),
        ),
        attention_mode="natural",
    )
    assert await recover_started(db_session._SessionLocal, "synthetic-batch") is True

    async with db_session._SessionLocal() as check_db:
        rows = (await check_db.execute(
            select(ConversationMessage).where(ConversationMessage.session_id == session_id)
            .order_by(ConversationMessage.conversation_seq)
        )).scalars().all()
        receipts = (await check_db.execute(
            select(ConversationBatch).where(ConversationBatch.session_id == session_id)
        )).scalars().all()
    assert [row.content for row in rows] == ["消息甲", "消息乙"]
    assert [row.client_message_id for row in rows] == [item["event_id"] for item in messages]
    assert all(row.run_id == user_run_key("synthetic-batch") for row in rows)
    assert [(receipt.version, receipt.run_id) for receipt in receipts] == [
        ("im-attention-passive-v1", user_run_key("synthetic-batch")),
    ]
    assert receipts[0].state_summary == {
        "kind": "attention_passive", "mode": "natural",
        "config_version": 0, "attention_version": "attention-v3.0.6",
        "actual_decision": "PASSIVE", "reason_codes": ["snapshot_incomplete"],
        "score": 0, "score_breakdown": None, "threshold": 70,
        "source_event_count": 2,
    }
    assert len(published) == 1 and len(published[0]["appended"]) == 2

    await conversation.record_passive_attention_batch(
        request, messages, session_id=session_id, batch_key="synthetic-batch",
    )
    async with db_session._SessionLocal() as check_db:
        rows = (await check_db.execute(
            select(ConversationMessage).where(ConversationMessage.session_id == session_id)
        )).scalars().all()
    assert len(rows) == 2
    assert len(published) == 1  # 重投只补收据/ACK，不重复发 SSE 气泡


@pytest.mark.asyncio
async def test_attachment_claim_failure_rolls_back_passive_rows_and_completion_receipt(
    db, user_a, monkeypatch,
):
    from agent.im import conversation
    from app.core import chat_attach

    session = ConversationSession(
        user_id=user_a.id, title="合成群", source="qq", bot_id="bot-synthetic",
        chat_id="group-synthetic", chat_type="group",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    session_id = session.id
    request = SimpleNamespace(
        user_id=user_a.id, source="qq", platform_bot_id="bot-synthetic",
        chat_id="group-synthetic", im_group_memory_enabled=False,
    )
    monkeypatch.setattr(
        chat_attach, "get_meta_many", lambda *_args, **_kwargs: _async_value({"attach-a": {}}),
    )
    monkeypatch.setattr(
        conversation, "build_attachment_cards", lambda *_args, **_kwargs: _async_value([
            {"attach_id": "attach-a", "name": "synthetic.png", "ext": "png", "size_bytes": 1},
        ]),
    )

    async def fail_claim(*_args, **_kwargs):
        raise chat_attach.AttachmentClaimError("synthetic claim failure")

    monkeypatch.setattr(chat_attach, "claim_attachments", fail_claim)
    with pytest.raises(chat_attach.AttachmentClaimError):
        await conversation.record_passive_attention_batch(
            request,
            [{
                "event_id": "1761746400000-0", "early_id": None, "text": "看看图",
                "platform_user_id": "member-a", "chat_type": "group", "attachments": ["attach-a"],
            }],
            session_id=session_id,
            batch_key="synthetic-failed-batch",
        )

    await db.rollback()
    rows = (await db.execute(
        select(ConversationMessage).where(ConversationMessage.session_id == session_id)
    )).scalars().all()
    receipts = (await db.execute(
        select(ConversationBatch).where(ConversationBatch.session_id == session_id)
    )).scalars().all()
    assert rows == []
    assert receipts == []


async def _async_value(value):
    return value
