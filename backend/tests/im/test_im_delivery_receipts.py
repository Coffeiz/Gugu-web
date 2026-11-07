from sqlalchemy import select

from agent.im.delivery_receipts import persist_attachment_delivery_receipt
from agent.context.message_roles import is_internal_user_message
from app.models import ConversationMessage, ConversationSession


async def test_failed_attachment_receipt_is_persisted_as_internal_context(db, user_a):
    conversation = ConversationSession(
        user_id=user_a.id,
        title="合成测试会话",
        source="qq",
        bot_id="synthetic-bot",
        chat_id="synthetic-chat",
        chat_type="group",
    )
    db.add(conversation)
    await db.commit()
    await db.refresh(conversation)

    saved = await persist_attachment_delivery_receipt(
        user_id=user_a.id,
        session_id=conversation.id,
        trace_id="synthetic-trace",
        requested=2,
        sent=1,
        failed=1,
    )
    repeated = await persist_attachment_delivery_receipt(
        user_id=user_a.id,
        session_id=conversation.id,
        trace_id="synthetic-trace",
        requested=2,
        sent=1,
        failed=1,
    )

    assert saved is True
    assert repeated is True
    rows = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.session_id == conversation.id,
            ConversationMessage.run_id == "attachment-receipt:synthetic-trace",
        )
    )).scalars().all()
    assert len(rows) == 1
    row = rows[0]
    assert row.role == "user"
    assert row.content == ""
    assert is_internal_user_message({"role": row.role, "content": row.content_json})
    receipt_text = row.content_json[0]["text"]
    assert "请求发送 2 个附件" in receipt_text
    assert "平台接口已受理 1 个" in receipt_text
    assert "收件人是否收到仍需确认" in receipt_text
    assert "未确认成功 1 个" in receipt_text


async def test_attachment_receipt_does_not_cross_user_session(db, user_a, user_b):
    conversation = ConversationSession(
        user_id=user_b.id,
        title="合成测试会话",
        source="qq",
        bot_id="synthetic-bot",
        chat_id="synthetic-chat",
        chat_type="group",
    )
    db.add(conversation)
    await db.commit()
    await db.refresh(conversation)

    saved = await persist_attachment_delivery_receipt(
        user_id=user_a.id,
        session_id=conversation.id,
        trace_id="synthetic-trace",
        requested=1,
        sent=0,
        failed=1,
    )

    assert saved is False
    rows = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.session_id == conversation.id,
        )
    )).scalars().all()
    assert rows == []
