"""思维画布 Agent/API 共用的主要写入边界。"""
from sqlalchemy import and_, false, func, or_, select, update

from app.core.mind import content_hash, to_plain_text, update_node_atomic, upsert_relation, validate_note_color
from app.core.mind_canvas import get_or_create_reference_node, soft_delete_canvas_note
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import MindCanvasItem, MindMap, MindNode, MindRelation, Project
from app.models import CalendarEvent, File
from app.search.query import keyword_condition


async def create_canvas(db, user_id, title, project_id=None):
    if project_id is not None and not await get_owned(db, Project, project_id, user_id):
        return None
    canvas = MindMap(user_id=user_id, title=title, project_id=project_id, data_json="{}")
    db.add(canvas)
    await db.commit()
    await db.refresh(canvas)
    return canvas


async def create_canvas_note(db, user_id, canvas_id, title, content, color, x, y):
    node = MindNode(
        user_id=user_id, kind="canvas_note", title=title, content_md=content,
        content_plain=to_plain_text(content), color=validate_note_color(color),
        indexed_hash=content_hash(to_plain_text(content)), indexed_at=None,
    )
    db.add(node)
    await db.flush()
    item = MindCanvasItem(user_id=user_id, canvas_id=canvas_id, node_id=node.id, x=x, y=y, z=0)
    db.add(item)
    await db.commit()
    await db.refresh(node)
    await db.refresh(item)
    return node, item


async def add_canvas_item(db, user_id, canvas_id, node, x, y):
    existing = await db.scalar(select(MindCanvasItem).where(
        MindCanvasItem.canvas_id == canvas_id,
        MindCanvasItem.node_id == node.id,
        MindCanvasItem.user_id == user_id,
    ))
    if existing is not None:
        await db.refresh(node)
        return existing, False
    item = MindCanvasItem(user_id=user_id, canvas_id=canvas_id, node_id=node.id, x=x, y=y, z=0)
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item, True


async def get_canvas_item(db, user_id, canvas_id, item_id):
    return await db.scalar(select(MindCanvasItem).where(
        MindCanvasItem.id == item_id,
        MindCanvasItem.canvas_id == canvas_id,
        MindCanvasItem.user_id == user_id,
    ))


async def get_canvas_item_by_node(db, user_id, canvas_id, node_id):
    return await db.scalar(select(MindCanvasItem).where(
        MindCanvasItem.canvas_id == canvas_id,
        MindCanvasItem.node_id == node_id,
        MindCanvasItem.user_id == user_id,
    ))


async def update_canvas_item(db, user_id, canvas_id, item_id, fields):
    item = await get_canvas_item(db, user_id, canvas_id, item_id)
    if item is None:
        return None
    await db.execute(update(MindCanvasItem).where(
        MindCanvasItem.id == item.id,
        MindCanvasItem.canvas_id == canvas_id,
        MindCanvasItem.user_id == user_id,
    ).values(**fields, updated_at=now_utc()))
    await db.commit()
    await db.refresh(item)
    return item


async def remove_canvas_item(db, user_id, canvas_id, item_id):
    item = await get_canvas_item(db, user_id, canvas_id, item_id)
    if item is None:
        return None
    node_id = item.node_id
    await db.delete(item)
    await db.commit()
    return node_id


async def update_canvas_note(db, user_id, node_id, version, fields):
    if not await update_node_atomic(db, node_id, user_id, version, fields):
        await db.rollback()
        return False
    await db.commit()
    return await get_owned(db, MindNode, node_id, user_id)


async def delete_canvas_note(db, user_id, node_id, version):
    if not await soft_delete_canvas_note(db, node_id, user_id, version):
        await db.rollback()
        return False
    await db.commit()
    return True


async def connect_nodes(db, user_id, canvas_id, source_id, target_id, rel_type="related"):
    items = (await db.execute(select(MindCanvasItem).where(
        MindCanvasItem.canvas_id == canvas_id,
        MindCanvasItem.user_id == user_id,
        MindCanvasItem.node_id.in_((source_id, target_id)),
    ))).scalars().all()
    if {item.node_id for item in items} != {source_id, target_id}:
        return None, "两个节点都必须已经放在同一张画布上"
    nodes = (await db.execute(select(MindNode).where(
        MindNode.id.in_((source_id, target_id)),
        MindNode.user_id == user_id,
        MindNode.kind.in_(("ref", "canvas_note")),
        MindNode.deleted_at.is_(None),
    ))).scalars().all()
    if len(nodes) != 2:
        return None, "只能连接画布便签或业务引用节点"
    try:
        relation = await upsert_relation(db, user_id, source_id, target_id, rel_type=rel_type)
    except ValueError as exc:
        return None, str(exc)
    await db.commit()
    await db.refresh(relation)
    return relation, None


async def disconnect_node_relation(db, user_id, relation_id):
    relation = await db.scalar(select(MindRelation).where(
        MindRelation.id == relation_id, MindRelation.user_id == user_id,
    ))
    if relation is None:
        return None
    await db.delete(relation)
    await db.commit()
    return relation


async def get_or_create_reference(db, user_id, ref_type, ref_id):
    return await get_or_create_reference_node(db, user_id, ref_type, ref_id)


async def get_owned_canvas(db, user_id, canvas_id):
    return await db.scalar(select(MindMap).where(MindMap.id == canvas_id, MindMap.user_id == user_id))


async def list_canvases(db, user_id, *, project_id=None, limit=20, offset=0):
    stmt = select(MindMap).where(MindMap.user_id == user_id)
    count_stmt = select(func.count()).select_from(MindMap).where(MindMap.user_id == user_id)
    if isinstance(project_id, int):
        stmt = stmt.where(MindMap.project_id == project_id)
        count_stmt = count_stmt.where(MindMap.project_id == project_id)
    rows = (await db.execute(
        stmt.order_by(MindMap.updated_at.desc(), MindMap.id.desc()).limit(limit).offset(offset)
    )).scalars().all()
    total = await db.scalar(count_stmt) or 0
    counts = {}
    if rows:
        count_rows = await db.execute(
            select(MindCanvasItem.canvas_id, func.count(MindCanvasItem.id))
            .where(MindCanvasItem.user_id == user_id, MindCanvasItem.canvas_id.in_([row.id for row in rows]))
            .group_by(MindCanvasItem.canvas_id)
        )
        counts = dict(count_rows.all())
    return rows, total, counts


async def list_canvas_nodes(db, user_id, canvas_id, *, limit):
    return (await db.execute(
        select(MindCanvasItem, MindNode)
        .join(MindNode, MindNode.id == MindCanvasItem.node_id)
        .where(
            MindCanvasItem.canvas_id == canvas_id,
            MindCanvasItem.user_id == user_id,
            MindNode.user_id == user_id,
            MindNode.kind.in_(("canvas_note", "ref")),
            MindNode.deleted_at.is_(None),
        )
        .order_by(MindCanvasItem.z, MindCanvasItem.id)
        .limit(limit)
    )).all()


async def list_canvas_relations(db, user_id, node_ids):
    if not node_ids:
        return []
    return (await db.execute(
        select(MindRelation).where(
            MindRelation.user_id == user_id,
            MindRelation.src_node_id.in_(node_ids),
            MindRelation.dst_node_id.in_(node_ids),
        ).order_by(MindRelation.id)
    )).scalars().all()


async def search_canvas_nodes(db, user_id, canvas_id, *, condition, limit):
    stmt = (
        select(MindCanvasItem, MindNode)
        .join(MindNode, MindNode.id == MindCanvasItem.node_id)
        .where(
            MindCanvasItem.canvas_id == canvas_id,
            MindCanvasItem.user_id == user_id,
            MindNode.user_id == user_id,
            MindNode.deleted_at.is_(None),
        )
        .order_by(MindCanvasItem.z.desc(), MindCanvasItem.id.desc())
        .limit(limit)
    )
    if condition is not None:
        stmt = stmt.where(condition)
    return (await db.execute(stmt)).all()


async def list_existing_reference_nodes(db, user_id, ref_types):
    return (await db.execute(select(MindNode).where(
        MindNode.user_id == user_id,
        MindNode.kind == "ref",
        MindNode.deleted_at.is_(None),
        MindNode.ref_type.in_(ref_types),
    ))).scalars().all()


async def list_existing_canvas_reference_items(db, user_id, canvas_id):
    return (await db.execute(
        select(MindCanvasItem, MindNode)
        .join(MindNode, MindNode.id == MindCanvasItem.node_id)
        .where(MindCanvasItem.canvas_id == canvas_id, MindCanvasItem.user_id == user_id, MindNode.kind == "ref")
    )).all()


async def search_placeable_entities(db, user_id, selected, normalized, mode, limit):
    matches = []
    if "project" in selected:
        matches.extend((await db.execute(select(Project).where(
            Project.user_id == user_id,
            keyword_condition([Project.name, Project.client], normalized, mode),
        ).order_by(Project.updated_at.desc()).limit(limit))).scalars().all())
    if "file" in selected and len(matches) < limit:
        matches.extend((await db.execute(select(File).where(
            File.user_id == user_id,
            File.deleted_at.is_(None),
            keyword_condition([File.display_name, File.ext, File.stage_name], normalized, mode),
        ).order_by(File.updated_at.desc()).limit(limit))).scalars().all())
    if "event" in selected and len(matches) < limit:
        matches.extend((await db.execute(select(CalendarEvent).where(
            CalendarEvent.user_id == user_id,
            keyword_condition([CalendarEvent.title, CalendarEvent.description, CalendarEvent.client], normalized, mode),
        ).order_by(CalendarEvent.created_at.desc()).limit(limit))).scalars().all())
    return matches
