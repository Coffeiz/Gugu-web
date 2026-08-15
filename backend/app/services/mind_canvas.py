"""思维画布 Agent/API 共用的主要写入边界。"""
import json

from sqlalchemy import and_, delete, false, func, or_, select, update

from app.core.mind import content_hash, to_plain_text, update_node_atomic, upsert_relation, validate_note_color
from app.core.mind_canvas import get_or_create_reference_node, soft_delete_canvas_note
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import MindCanvasItem, MindMap, MindNode, MindRelation, Project
from app.models import CalendarEvent, File
from app.search.query import keyword_condition

_RELATION_SIDES = frozenset(("left", "right"))


def relation_anchor_from_canvas(canvas, relation_id):
    """读取画布视图中保存的关系端点；关系语义本身仍由 MindRelation 保存。"""
    try:
        data = json.loads(canvas.data_json or "{}")
    except (TypeError, json.JSONDecodeError):
        return None
    raw = data.get("relationAnchors", {}).get(str(relation_id)) if isinstance(data, dict) else None
    if not isinstance(raw, dict):
        return None
    src_side, dst_side = raw.get("srcSide"), raw.get("dstSide")
    if src_side not in _RELATION_SIDES or dst_side not in _RELATION_SIDES:
        return None
    return {"source_side": src_side, "target_side": dst_side}


async def update_relation_anchor(db, user_id, canvas_id, relation, source_side, target_side, *, commit=False):
    """更新指定画布上的关系端点，保留画布 data_json 的其它视图状态。"""
    if source_side not in _RELATION_SIDES or target_side not in _RELATION_SIDES:
        raise ValueError("连接点只能是 left 或 right")
    canvas = await get_owned_canvas(db, user_id, canvas_id)
    if canvas is None:
        return None
    node_ids = (await db.execute(select(MindCanvasItem.node_id).where(
        MindCanvasItem.canvas_id == canvas_id,
        MindCanvasItem.user_id == user_id,
        MindCanvasItem.node_id.in_((relation.src_node_id, relation.dst_node_id)),
    ))).scalars().all()
    if set(node_ids) != {relation.src_node_id, relation.dst_node_id}:
        return None
    try:
        data = json.loads(canvas.data_json or "{}")
    except (TypeError, json.JSONDecodeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    anchors = data.get("relationAnchors")
    if not isinstance(anchors, dict):
        anchors = {}
    anchors[str(relation.id)] = {"srcSide": source_side, "dstSide": target_side}
    data["relationAnchors"] = anchors
    canvas.data_json = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(canvas)
    return {"source_side": source_side, "target_side": target_side}


async def create_canvas(db, user_id, title, project_id=None, *, commit=False):
    if project_id is not None and not await get_owned(db, Project, project_id, user_id):
        return None
    canvas = MindMap(user_id=user_id, title=title, project_id=project_id, data_json="{}")
    db.add(canvas)
    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(canvas)
    return canvas


async def update_canvas(db, user_id, canvas_id, fields, *, commit=False):
    """更新画布自身的标题/视图数据，默认只 flush。"""
    canvas = await get_owned_canvas(db, user_id, canvas_id)
    if canvas is None:
        return None
    if "title" in fields:
        canvas.title = fields["title"]
    if "data_json" in fields:
        canvas.data_json = fields["data_json"]
    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(canvas)
    return canvas


async def delete_canvas(db, user_id, canvas_id, *, commit=False):
    """删除画布视图及画布记录，不删除全局节点/关系。"""
    canvas = await get_owned_canvas(db, user_id, canvas_id)
    if canvas is None:
        return False
    await db.execute(delete(MindCanvasItem).where(MindCanvasItem.canvas_id == canvas_id))
    await db.delete(canvas)
    if commit:
        await db.commit()
    else:
        await db.flush()
    return True


async def create_canvas_note(
    db, user_id, canvas_id, title, content, color, x, y, *, w=None, h=None, z=0, commit=False,
):
    node = MindNode(
        user_id=user_id, kind="canvas_note", title=title, content_md=content,
        content_plain=to_plain_text(content), color=validate_note_color(color),
        indexed_hash=content_hash(to_plain_text(content)), indexed_at=None,
    )
    db.add(node)
    await db.flush()
    item = MindCanvasItem(
        user_id=user_id, canvas_id=canvas_id, node_id=node.id,
        x=x, y=y, w=w, h=h, z=z,
    )
    db.add(item)
    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(node)
    await db.refresh(item)
    return node, item


async def add_canvas_item(
    db, user_id, canvas_id, node, x, y, *, w=None, h=None, z=0, collapsed=False,
    data_json=None, commit=False,
):
    existing = await db.scalar(select(MindCanvasItem).where(
        MindCanvasItem.canvas_id == canvas_id,
        MindCanvasItem.node_id == node.id,
        MindCanvasItem.user_id == user_id,
    ))
    if existing is not None:
        await db.refresh(node)
        return existing, False
    item = MindCanvasItem(
        user_id=user_id, canvas_id=canvas_id, node_id=node.id,
        x=x, y=y, w=w, h=h, z=z, collapsed=collapsed,
        data_json=data_json or "{}",
    )
    db.add(item)
    if commit:
        await db.commit()
    else:
        await db.flush()
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


async def list_canvas_items(db, user_id, canvas_id):
    return (await db.execute(
        select(MindCanvasItem, MindNode)
        .join(MindNode, MindNode.id == MindCanvasItem.node_id)
        .where(
            MindCanvasItem.canvas_id == canvas_id,
            MindCanvasItem.user_id == user_id,
            MindNode.user_id == user_id,
        )
        .order_by(MindCanvasItem.z, MindCanvasItem.id)
    )).all()


async def get_canvas_node(db, user_id, node_id, *, kind=None, deleted=None):
    """按归属读取画布节点，统一处理节点类型和软删除条件。"""
    node = await get_owned(db, MindNode, node_id, user_id)
    if node is None:
        return None
    if kind is not None and node.kind != kind:
        return None
    if deleted is not None and (node.deleted_at is not None) != deleted:
        return None
    return node


async def get_canvas_relation(db, user_id, relation_id):
    return await get_owned(db, MindRelation, relation_id, user_id)


async def update_canvas_item(db, user_id, canvas_id, item_id, fields, *, commit=False):
    item = await get_canvas_item(db, user_id, canvas_id, item_id)
    if item is None:
        return None
    await db.execute(update(MindCanvasItem).where(
        MindCanvasItem.id == item.id,
        MindCanvasItem.canvas_id == canvas_id,
        MindCanvasItem.user_id == user_id,
    ).values(**fields, updated_at=now_utc()))
    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(item)
    return item


async def remove_canvas_item(db, user_id, canvas_id, item_id, *, commit=False):
    item = await get_canvas_item(db, user_id, canvas_id, item_id)
    if item is None:
        return None
    node_id = item.node_id
    await db.delete(item)
    if commit:
        await db.commit()
    else:
        await db.flush()
    return node_id


async def update_canvas_note(db, user_id, node_id, version, fields, *, commit=False):
    if not await update_node_atomic(db, node_id, user_id, version, fields):
        return False
    if commit:
        await db.commit()
    else:
        await db.flush()
    return await get_owned(db, MindNode, node_id, user_id)


async def delete_canvas_note(db, user_id, node_id, version, *, commit=False):
    if not await soft_delete_canvas_note(db, node_id, user_id, version):
        return False
    if commit:
        await db.commit()
    else:
        await db.flush()
    return True


async def connect_nodes(db, user_id, canvas_id, source_id, target_id, rel_type="related", *, commit=False):
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
    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(relation)
    return relation, None


async def create_relation(
    db, user_id, source_id, target_id, *, rel_type="related", allow_parallel=False, commit=False,
):
    """创建全局节点关系；画布/API 共用，默认幂等并只 flush。"""
    if source_id == target_id:
        return None, "节点不能连向自己"
    nodes = (await db.execute(select(MindNode).where(
        MindNode.id.in_((source_id, target_id)),
        MindNode.user_id == user_id,
        MindNode.deleted_at.is_(None),
    ))).scalars().all()
    if len(nodes) != 2:
        return None, "节点不存在"
    try:
        relation = await upsert_relation(
            db, user_id, source_id, target_id,
            rel_type=rel_type, allow_parallel=allow_parallel,
        )
    except ValueError as exc:
        return None, str(exc)
    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(relation)
    return relation, None


async def bring_canvas_item_to_front(db, user_id, canvas_id, item_id, x, y, *, commit=False):
    """在画布内置顶节点并更新位置，保持整个排序操作一个事务。"""
    rows = await list_canvas_items(db, user_id, canvas_id)
    target = next(((item, node) for item, node in rows if item.id == item_id), None)
    if target is None:
        return None
    for index, (item, _) in enumerate([row for row in rows if row[0].id != item_id] + [target], start=1):
        item.z = index * 1000
    target_item, target_node = target
    target_item.x, target_item.y = x, y
    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(target_item)
    return target_item, target_node


async def disconnect_node_relation(db, user_id, relation_id, *, commit=False):
    relation = await db.scalar(select(MindRelation).where(
        MindRelation.id == relation_id, MindRelation.user_id == user_id,
    ))
    if relation is None:
        return None
    await db.delete(relation)
    if commit:
        await db.commit()
    else:
        await db.flush()
    return relation


async def get_or_create_reference(db, user_id, ref_type, ref_id):
    return await get_or_create_reference_node(db, user_id, ref_type, ref_id)


async def get_owned_canvas(db, user_id, canvas_id):
    return await db.scalar(select(MindMap).where(MindMap.id == canvas_id, MindMap.user_id == user_id))


async def get_canvas_near_item(db, user_id, canvas_id, node_id):
    return await db.scalar(select(MindCanvasItem).where(
        MindCanvasItem.canvas_id == canvas_id,
        MindCanvasItem.user_id == user_id,
        MindCanvasItem.node_id == node_id,
    ))


async def get_canvas_last_item(db, user_id, canvas_id):
    return (await db.execute(select(MindCanvasItem).where(
        MindCanvasItem.canvas_id == canvas_id,
        MindCanvasItem.user_id == user_id,
    ).order_by(MindCanvasItem.x.desc(), MindCanvasItem.id.desc()).limit(1))).scalars().first()


async def get_owned_project(db, user_id, project_id):
    return await get_owned(db, Project, project_id, user_id)


async def get_canvas_reference_node(db, user_id, node_id):
    node = await get_owned(db, MindNode, node_id, user_id)
    return node if node and node.kind == "ref" and node.deleted_at is None else None


async def get_canvas_note(db, user_id, node_id):
    node = await get_owned(db, MindNode, node_id, user_id)
    return node if node and node.kind == "canvas_note" and node.deleted_at is None else None


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


def _canvas_type_condition(selected):
    selected = selected or []
    conditions = [MindNode.kind == "canvas_note"] if "canvas_note" in selected else []
    ref_types = [item for item in selected if item in {"project", "file", "event"}]
    if ref_types:
        conditions.append(and_(MindNode.kind == "ref", MindNode.ref_type.in_(ref_types)))
    return or_(*conditions) if conditions else false()


async def search_canvas_nodes(db, user_id, canvas_id, *, selected=None, normalized=None, mode=None, limit):
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
    condition = _canvas_type_condition(selected)
    if normalized:
        condition = and_(condition, keyword_condition([MindNode.title, MindNode.content_plain], normalized, mode))
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
        rows = (await db.execute(select(Project).where(
            Project.user_id == user_id,
            keyword_condition([Project.name, Project.client], normalized, mode),
        ).order_by(Project.updated_at.desc()).limit(limit))).scalars().all()
        matches.extend(("project", row) for row in rows)
    if "file" in selected and len(matches) < limit:
        rows = (await db.execute(select(File).where(
            File.user_id == user_id,
            File.deleted_at.is_(None),
            keyword_condition([File.display_name, File.ext, File.stage_name], normalized, mode),
        ).order_by(File.updated_at.desc()).limit(limit))).scalars().all()
        matches.extend(("file", row) for row in rows)
    if "event" in selected and len(matches) < limit:
        rows = (await db.execute(select(CalendarEvent).where(
            CalendarEvent.user_id == user_id,
            keyword_condition([CalendarEvent.title, CalendarEvent.description, CalendarEvent.client], normalized, mode),
        ).order_by(CalendarEvent.created_at.desc()).limit(limit))).scalars().all()
        matches.extend(("event", row) for row in rows)
    return matches


async def batch_canvas_operations(db, user_id, canvas, operations, request_id, *, resolve_position, summarize):
    """执行画布批量放置、布局和连接；任一操作失败都回滚整批。"""
    results = []
    try:
        for index, operation in enumerate(operations):
            if not isinstance(operation, dict):
                raise ValueError(f"第 {index + 1} 个操作格式不正确")
            kind = operation.get("kind")
            if kind == "add_node":
                ref_type, ref_id = operation.get("ref_type"), operation.get("ref_id")
                if ref_type not in {"project", "file", "event"} or not isinstance(ref_id, int):
                    raise ValueError(f"第 {index + 1} 个放置操作缺少有效引用")
                node, _ = await get_or_create_reference_node(db, user_id, ref_type, ref_id)
                item = await get_canvas_item_by_node(db, user_id, canvas.id, node.id)
                created = item is None
                if item is None:
                    x, y = await resolve_position(db, user_id, canvas, node, operation.get("position"))
                    item = MindCanvasItem(user_id=user_id, canvas_id=canvas.id, node_id=node.id, x=x, y=y, z=0)
                    db.add(item)
                    await db.flush()
                results.append({"index": index, "kind": kind, "created": created, "node": summarize(node, item)})
            elif kind == "update_item":
                item_id = operation.get("item_id")
                if not isinstance(item_id, int):
                    raise ValueError(f"第 {index + 1} 个布局操作缺少 item_id")
                item = await get_canvas_item(db, user_id, canvas.id, item_id)
                if item is None:
                    raise ValueError(f"第 {index + 1} 个布局操作找不到节点")
                fields = {key: operation[key] for key in ("x", "y", "w", "h", "z", "collapsed") if key in operation}
                for key in ("x", "y", "w", "h"):
                    if key in fields and (not isinstance(fields[key], (int, float)) or isinstance(fields[key], bool) or (key in ("w", "h") and fields[key] <= 0)):
                        raise ValueError(f"第 {index + 1} 个布局操作包含无效 {key}")
                if not fields:
                    raise ValueError(f"第 {index + 1} 个布局操作没有修改字段")
                await db.execute(update(MindCanvasItem).where(MindCanvasItem.id == item.id).values(**fields, updated_at=now_utc()))
                await db.flush()
                await db.refresh(item)
                node = await get_owned(db, MindNode, item.node_id, user_id)
                results.append({"index": index, "kind": kind, "updated": True, "node": summarize(node, item)})
            elif kind == "connect":
                source_id, target_id = operation.get("source_node_id"), operation.get("target_node_id")
                if not isinstance(source_id, int) or not isinstance(target_id, int):
                    raise ValueError(f"第 {index + 1} 个连接操作缺少节点")
                source_side, target_side = operation.get("source_side"), operation.get("target_side")
                if (source_side is None) != (target_side is None):
                    raise ValueError(f"第 {index + 1} 个连接操作的两端连接点必须同时提供")
                if ((source_side is not None and source_side not in _RELATION_SIDES)
                        or (target_side is not None and target_side not in _RELATION_SIDES)):
                    raise ValueError(f"第 {index + 1} 个连接操作的连接点只能是 left 或 right")
                relation, error = await connect_nodes(db, user_id, canvas.id, source_id, target_id, commit=False)
                if error:
                    raise ValueError(f"第 {index + 1} 个连接操作{error}")
                if source_side is not None:
                    sides = (source_side, target_side) if source_id == relation.src_node_id else (target_side, source_side)
                    if await update_relation_anchor(db, user_id, canvas.id, relation, *sides, commit=False) is None:
                        raise ValueError(f"第 {index + 1} 个连接操作找不到关系所在画布")
                await db.flush()
                results.append({"index": index, "kind": kind, "relation_id": relation.id, "created_or_reused": True})
            else:
                raise ValueError(f"不支持的批量操作 {kind or '空操作'}；删除请使用单独工具确认")
        await db.commit()
    except Exception as exc:
        await db.rollback()
        return {"error": str(exc), "request_id": request_id, "rolled_back": True}
    return {"canvas_id": canvas.id, "request_id": request_id, "operations": results, "atomic": True}
