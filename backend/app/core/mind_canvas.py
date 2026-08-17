"""画布写入共用领域服务。

网页 API 和 Agent 工具都从这里复用业务引用节点的归属校验、快照和复用逻辑，避免两条
写入链路产生不同的 ref 节点或绕过用户隔离。
"""
from __future__ import annotations

from sqlalchemy import delete, select, update

from app.core.ownership import get_owned
from app.models import CalendarEvent, File, MindCanvasItem, MindNode, Project
from app.core.tz import now_utc

_REF_TARGETS = {
    "project": (Project, "name"),
    "file": (File, "display_name"),
    "event": (CalendarEvent, "title"),
}


async def get_reference_entity(db, user_id, ref_type: str, ref_id: int):
    target = _REF_TARGETS.get(ref_type)
    if target is None:
        raise ValueError("不支持的引用类型")
    model, _ = target
    entity = await get_owned(db, model, ref_id, user_id)
    if entity is None or (ref_type == "file" and entity.deleted_at is not None):
        raise LookupError("引用对象不存在")
    return entity


def _reference_snapshot(ref_type: str, entity) -> dict | None:
    if ref_type == "project":
        return {
            "client": entity.client,
            "status": entity.status,
            "startDate": entity.start_date,
            "deadline": entity.deadline,
            "doneAt": entity.done_at.isoformat() if entity.done_at else None,
        }
    if ref_type == "file":
        return {"ext": entity.ext}
    if ref_type == "event":
        return {"date": entity.date, "time": entity.time, "endTime": entity.end_time}
    return None


async def get_or_create_reference_node(db, user_id, ref_type: str, ref_id: int) -> tuple[MindNode, bool]:
    """返回当前用户的唯一引用节点；第二项表示本次是否新建。"""
    entity = await get_reference_entity(db, user_id, ref_type, ref_id)
    node = await db.scalar(
        select(MindNode).where(
            MindNode.user_id == user_id,
            MindNode.kind == "ref",
            MindNode.ref_type == ref_type,
            MindNode.ref_id == ref_id,
            MindNode.deleted_at.is_(None),
        )
    )
    if node is not None:
        return node, False
    _, label_attr = _REF_TARGETS[ref_type]
    node = MindNode(
        user_id=user_id,
        kind="ref",
        ref_type=ref_type,
        ref_id=ref_id,
        title=getattr(entity, label_attr),
        content_md="",
        content_plain="",
        color=getattr(entity, "color", None) if ref_type == "project" else None,
        ref_snapshot=_reference_snapshot(ref_type, entity),
    )
    db.add(node)
    await db.flush()
    return node, True


async def soft_delete_canvas_note(db, node_id: int, user_id, client_version: int) -> bool:
    """原子软删画布便签，并移除其视图项；正文节点保留以便审计/恢复。"""
    from app.core.mind import _as_uuid
    result = await db.execute(
        update(MindNode).where(
            MindNode.id == node_id,
            MindNode.user_id == _as_uuid(user_id),
            MindNode.kind == "canvas_note",
            MindNode.version == client_version,
            MindNode.deleted_at.is_(None),
        ).values(deleted_at=now_utc(), updated_at=now_utc(), version=MindNode.version + 1)
    )
    if result.rowcount != 1:
        return False
    await db.execute(delete(MindCanvasItem).where(
        MindCanvasItem.node_id == node_id,
        MindCanvasItem.user_id == _as_uuid(user_id),
    ))
    return True
