"""Agent 会话内的撤销记录与最近一次操作撤销。"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.models import UndoOperation
from app.services.undo.service import UndoError, UndoService


def agent_undo_context(session_id: int) -> str:
    return f"agent-session:{session_id}"


async def record_agent_forward(db: AsyncSession, *, user_id, session_id: int | None, **operation):
    """把 Agent 操作记录在对应会话的独立撤销栈中。"""
    if session_id is None:
        return None
    return await UndoService.record_forward(
        db,
        user_id=user_id,
        context_id=agent_undo_context(session_id),
        actor_type="agent",
        **operation,
    )


async def undo_latest_agent_action(db: AsyncSession, *, user_id, session_id: int | None) -> dict:
    if session_id is None:
        return {"error": "当前没有可用的对话撤销范围"}
    context_id = agent_undo_context(session_id)
    operation = (await db.execute(
        select(UndoOperation).where(
            UndoOperation.user_id == user_id,
            UndoOperation.undo_context_id == context_id,
            UndoOperation.actor_type == "agent",
            UndoOperation.status == "active",
        ).order_by(UndoOperation.created_at.desc(), UndoOperation.id.desc()).limit(1)
    )).scalar_one_or_none()
    if operation is None:
        return {"error": "当前对话没有可撤销的咕咕操作"}
    try:
        result = await UndoService.apply(
            db,
            user_id=user_id,
            context_id=context_id,
            operation_id=operation.id,
            mode="undo",
            actor_type="agent",
        )
    except UndoError as error:
        await db.commit()
        return {"error": error.message, "code": error.code}

    await db.commit()
    for item in result.get("events", []):
        try:
            await events.publish(
                user_id,
                item["resource"],
                origin=item["origin"],
                operation=item["operation"],
                entity_ids=item["entity_ids"],
            )
        except Exception:
            # 撤销事务已提交；实时通知失败不能把成功操作报告成失败。
            pass
    return {"success": True, "action": operation.action, "resource": operation.resource,
            "target_count": len(operation.target_refs or [])}
