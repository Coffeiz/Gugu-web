"""时间流思维节点的查询边界。"""
from sqlalchemy import or_, select

from app.core.ownership import get_owned
from app.models import MindNode, MindRelation
from app.search.query import keyword_condition


async def get_live_note(db, user_id, node_id):
    node = await get_owned(db, MindNode, node_id, user_id)
    return node if node and node.kind == "note" and node.deleted_at is None else None


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
