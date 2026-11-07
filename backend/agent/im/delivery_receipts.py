"""IM 出站附件投递结果的内部会话回执。"""
from __future__ import annotations


async def persist_attachment_delivery_receipt(
    *,
    user_id,
    session_id: int | None,
    trace_id: str,
    requested: int,
    sent: int,
    failed: int,
) -> bool:
    """将附件实际投递结果写入会话 canonical history，供后续 run 判断。"""
    if not session_id or failed <= 0:
        return False

    import app.db.session as db_session
    from sqlalchemy import select

    from app.models import ConversationMessage, ConversationSession

    if db_session._engine is None:
        db_session._build_engine()

    receipt_run_id = f"attachment-receipt:{str(trace_id or '')[:100]}"
    text = (
        "附件投递回执（内部状态）：本轮请求发送 "
        f"{max(0, int(requested))} 个附件，平台接口确认发送成功 "
        f"{max(0, int(sent))} 个，未确认成功 {max(0, int(failed))} 个。"
        "附件工具准备成功不代表平台接口接受成功；超时等情况也可能无法确认最终状态。"
        "后续如涉及这些附件，请以此回执为准；不要声称未确认成功的附件已经送达，"
        "对未确认的附件应先向用户核实；确认未收到且用户要求后再重新发送。"
    )

    try:
        async with db_session._SessionLocal() as db:
            session = await db.get(ConversationSession, session_id)
            if session is None or session.user_id != user_id:
                return False
            existing = (await db.execute(
                select(ConversationMessage.id).where(
                    ConversationMessage.session_id == session_id,
                    ConversationMessage.run_id == receipt_run_id,
                ).limit(1)
            )).scalar_one_or_none()
            if existing is not None:
                return True

            db.add(ConversationMessage(
                session_id=session_id,
                role="user",
                content="",
                content_json=[{"type": "runtime-context", "text": text}],
                run_id=receipt_run_id,
                round_id="attachment-delivery",
            ))
            await db.commit()
        return True
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.attachment_receipt.persist", exc)
        return False
