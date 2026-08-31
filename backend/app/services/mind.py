"""时间流思维节点的查询与写入边界。"""
from sqlalchemy import func, or_, select

from app.core.mind import (
    create_mind_note,
    soft_delete_mind_note,
    update_mind_note,
)
from app.core.ownership import get_owned
from app.models import MindNode, MindRelation
from app.search.query import keyword_condition


async def get_live_note(db, user_id, node_id):
    node = await get_owned(db, MindNode, node_id, user_id)
    return node if node and node.kind == "note" and node.deleted_at is None else None


async def list_notes(db, user_id, *, limit=50, offset=0):
    """查询时间流便签；分页和归属条件统一由 Service 持有。"""
    return (await db.execute(
        select(MindNode)
        .where(
            MindNode.user_id == user_id,
            MindNode.kind == "note",
            MindNode.deleted_at.is_(None),
        )
        .order_by(
            func.date(MindNode.captured_at).desc(),
            MindNode.created_at.desc(),
            MindNode.id.desc(),
        )
        .limit(limit)
        .offset(offset)
    )).scalars().all()


async def create_note(db, user_id, *, content_md, title=None, color=None, captured_at=None,
                      commit=False):
    """创建时间流便签；默认只 flush，由 API/任务边界提交。"""
    note = await create_mind_note(
        db,
        user_id,
        content_md=content_md,
        title=title,
        color=color,
        captured_at=captured_at,
    )
    if commit:
        await db.commit()
    return note


async def update_note(db, user_id, node_id, client_version, fields, *, commit=False):
    """按版本原子更新时间流便签；返回是否成功。"""
    updated = await update_mind_note(db, node_id, user_id, client_version, fields)
    if updated and commit:
        await db.commit()
    return updated


async def delete_note(db, user_id, node_id, client_version, *, commit=False):
    """按版本软删时间流便签；返回是否成功。"""
    deleted = await soft_delete_mind_note(db, node_id, user_id, client_version)
    if deleted and commit:
        await db.commit()
    return deleted


async def get_user_node(db, user_id, node_id):
    return await get_owned(db, MindNode, node_id, user_id)


async def list_live_nodes(db, user_id, node_ids):
    if not node_ids:
        return {}
    rows = (await db.execute(select(MindNode).where(
        MindNode.user_id == user_id, MindNode.id.in_(node_ids), MindNode.deleted_at.is_(None),
    ))).scalars().all()
    return {node.id: node for node in rows}


async def list_node_relations(db, user_id, node_ids):
    if not node_ids:
        return []
    return (await db.execute(select(MindRelation).where(
        MindRelation.user_id == user_id,
        or_(MindRelation.src_node_id.in_(node_ids), MindRelation.dst_node_id.in_(node_ids)),
    ).order_by(MindRelation.created_at.desc()))).scalars().all()


async def search_live_nodes(db, user_id, queries, mode, limit):
    return (await db.execute(select(MindNode).where(
        MindNode.user_id == user_id,
        MindNode.kind.in_(("note", "canvas_note")),
        MindNode.deleted_at.is_(None),
        keyword_condition([MindNode.title, MindNode.content_plain], queries, mode),
    ).order_by(MindNode.captured_at.desc()).limit(limit))).scalars().all()


async def latest_gugu_note(db, user_id):
    return await db.scalar(select(MindNode).where(
        MindNode.user_id == user_id, MindNode.kind == "note", MindNode.origin == "gugu",
        MindNode.deleted_at.is_(None),
    ).order_by(MindNode.created_at.desc(), MindNode.id.desc()).limit(1))
