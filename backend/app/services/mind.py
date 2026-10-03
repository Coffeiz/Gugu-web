"""时间流思维节点的查询与写入边界。"""
from sqlalchemy import func, or_, select

from app.core.mind import (
    create_mind_note,
    extract_mind_references,
    soft_delete_mind_note,
    update_mind_note,
)
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import CalendarEvent, File, MindNode, MindRelation, Project, ScheduledTask, UserMcpServer, UserSkill
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


async def list_note_references(db, user_id, nodes):
    """正文引用独立于关系边；只返回当前用户可读取的未删除对象。"""
    targets = {"project": (Project, "name"), "file": (File, "display_name"), "event": (CalendarEvent, "title")}
    parsed = {node.id: extract_mind_references(node.content_md) for node in nodes}
    cache = {}
    for ref_type, (model, label_field) in targets.items():
        ids = {ref_id for refs in parsed.values() for kind, ref_id in refs if kind == ref_type}
        if not ids:
            continue
        # 先批量限定归属，失效正文锚点只被过滤，不触发越权告警；存活对象再经统一归属门。
        entities = (await db.scalars(select(model).where(
            model.user_id == user_id, model.id.in_(ids), model.deleted_at.is_(None),
        ))).all()
        for candidate in entities:
            entity = await get_owned(db, model, candidate.id, user_id)
            if entity is not None:
                cache[(ref_type, entity.id)] = {
                    "ref_type": ref_type, "ref_id": entity.id, "label": getattr(entity, label_field),
                }
    return {node_id: [dict(cache[ref]) for ref in refs if ref in cache]
            for node_id, refs in parsed.items()}


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


async def list_recent_reference_extras(db, user_id, *, limit: int):
    """读取 @ 引用补全中的 Skill、MCP 与有效定时任务候选。"""
    skills = (await db.scalars(
        select(UserSkill).where(UserSkill.owner_id == user_id)
        .order_by(UserSkill.updated_at.desc()).limit(limit)
    )).all()
    mcp_servers = (await db.scalars(
        select(UserMcpServer).where(
            or_(UserMcpServer.user_id == user_id, UserMcpServer.scope == "platform"),
        ).order_by(UserMcpServer.name).limit(limit)
    )).all()
    tasks = (await db.scalars(
        select(ScheduledTask).where(
            ScheduledTask.user_id == user_id,
            ScheduledTask.enabled.is_(True),
            or_(ScheduledTask.end_at.is_(None), ScheduledTask.end_at > now_utc()),
        ).order_by(ScheduledTask.updated_at.desc()).limit(limit)
    )).all()
    return skills, mcp_servers, tasks


async def list_user_prompt_skills(db, user_id):
    """列出当前用户自定义 Prompt Skill，按名称和稳定 slug 排序。"""
    return (await db.scalars(
        select(UserSkill).where(
            UserSkill.owner_id == user_id,
            UserSkill.source == "user",
        ).order_by(UserSkill.name, UserSkill.slug)
    )).all()


async def get_user_prompt_skill(db, user_id, slug):
    """按稳定 slug 读取当前用户自定义 Prompt Skill。"""
    return await db.scalar(select(UserSkill).where(
        UserSkill.owner_id == user_id,
        UserSkill.slug == slug,
        UserSkill.source == "user",
    ))
