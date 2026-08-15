"""思维画布只读工具。

画布工具与时间流笔记工具分开：普通 ``note`` 不属于可放置对象；画布内搜索只返回
``canvas_note`` 和已经存在的业务引用节点。所有查询都按当前用户归属过滤，不接受模型
传入 user_id。
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import and_, false, func, or_, select, update

from app.core.mind import validate_note_color
from app.core.mind_canvas import get_or_create_reference_node, soft_delete_canvas_note
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import CalendarEvent, File, MindCanvasItem, MindMap, MindNode, MindRelation, Project
from app.services.mind_canvas import (
    add_canvas_item,
    connect_nodes,
    create_canvas,
    create_canvas_note,
    delete_canvas_note,
    disconnect_node_relation,
    get_canvas_item,
    get_canvas_item_by_node,
    get_or_create_reference,
    remove_canvas_item,
    update_canvas_item,
    update_canvas_note,
)
from app.search.query import keyword_condition, normalize_queries
from agent.tools.base import BaseSkill, Tool

_MAX_RESULTS = 20
_PLACEABLE_TYPES = ("project", "file", "event")
_CANVAS_TYPES = ("canvas_note", "project", "file", "event")


def _json_object(raw: str | None) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _limit(value: Any, default: int = 10) -> int:
    if not isinstance(value, int):
        return default
    return max(1, min(value, _MAX_RESULTS))


def _view_summary(canvas: MindMap) -> dict[str, Any]:
    """返回可供模型理解的世界视图；不把屏幕坐标伪装成节点坐标。"""
    data = _json_object(canvas.data_json)
    camera = {
        key: data[key]
        for key in ("x", "y", "scale")
        if isinstance(data.get(key), (int, float))
    }
    viewport_raw = data.get("viewport")
    viewport = None
    if isinstance(viewport_raw, dict):
        viewport = {
            key: viewport_raw[key]
            for key in ("width", "height")
            if isinstance(viewport_raw.get(key), (int, float))
        } or None
    return {
        "camera": camera or None,
        "viewport": viewport,
        "last_viewed_at": data.get("last_viewed_at") if isinstance(data.get("last_viewed_at"), str) else None,
    }


def _node_summary(node: MindNode, item: MindCanvasItem | None = None, *, include_content: bool = False) -> dict[str, Any]:
    plain = (node.content_plain or "").strip()
    result: dict[str, Any] = {
        "node_id": node.id,
        "kind": node.kind,
        "title": node.title,
        "ref_type": node.ref_type,
        "ref_id": node.ref_id,
        "preview": plain[:240],
    }
    if item is not None:
        result.update({
            "item_id": item.id,
            "position": {"x": item.x, "y": item.y},
            "size": {"w": item.w, "h": item.h},
            "collapsed": item.collapsed,
            "z": item.z,
        })
    if include_content:
        result["content_md"] = node.content_md
        result["content_plain"] = node.content_plain
    return result


async def _get_owned_canvas(db, user_id, canvas_id: int) -> MindMap | None:
    return await db.scalar(select(MindMap).where(MindMap.id == canvas_id, MindMap.user_id == user_id))


async def _mind_list_canvases(db, user_id, args: dict):
    limit = _limit(args.get("limit"), 20)
    offset = args.get("offset", 0)
    offset = offset if isinstance(offset, int) and offset >= 0 else 0
    project_id = args.get("project_id")
    stmt = select(MindMap).where(MindMap.user_id == user_id)
    if isinstance(project_id, int):
        stmt = stmt.where(MindMap.project_id == project_id)
    rows = (await db.execute(stmt.order_by(MindMap.updated_at.desc(), MindMap.id.desc()).limit(limit).offset(offset))).scalars().all()
    count_stmt = select(func.count()).select_from(MindMap).where(MindMap.user_id == user_id)
    if isinstance(project_id, int):
        count_stmt = count_stmt.where(MindMap.project_id == project_id)
    total = await db.scalar(count_stmt) or 0
    counts = {}
    if rows:
        count_rows = await db.execute(
            select(MindCanvasItem.canvas_id, func.count(MindCanvasItem.id))
            .where(MindCanvasItem.user_id == user_id, MindCanvasItem.canvas_id.in_([row.id for row in rows]))
            .group_by(MindCanvasItem.canvas_id)
        )
        counts = dict(count_rows.all())
    return {
        "canvases": [
            {
                "canvas_id": canvas.id,
                "title": canvas.title,
                "project_id": canvas.project_id,
                "updated_at": canvas.updated_at.isoformat(),
                "node_count": counts.get(canvas.id, 0),
                "view": _view_summary(canvas),
            }
            for canvas in rows
        ],
        "total": total,
        "offset": offset,
        "limit": limit,
    }


async def _mind_get_canvas(db, user_id, args: dict):
    canvas_id = args.get("canvas_id")
    if not isinstance(canvas_id, int):
        return {"error": "需要提供 canvas_id"}
    canvas = await _get_owned_canvas(db, user_id, canvas_id)
    if canvas is None:
        return {"error": "画布不存在"}
    include_nodes = args.get("include_nodes", True) is not False
    include_relations = args.get("include_relations", True) is not False
    include_content = args.get("include_content") is True
    limit = _limit(args.get("limit"), _MAX_RESULTS)
    result: dict[str, Any] = {
        "canvas": {
            "canvas_id": canvas.id,
            "title": canvas.title,
            "project_id": canvas.project_id,
            "created_at": canvas.created_at.isoformat(),
            "updated_at": canvas.updated_at.isoformat(),
            "view": _view_summary(canvas),
        }
    }
    if not include_nodes:
        return result
    rows = (await db.execute(
        select(MindCanvasItem, MindNode)
        .join(MindNode, MindNode.id == MindCanvasItem.node_id)
        .where(
            MindCanvasItem.canvas_id == canvas.id,
            MindCanvasItem.user_id == user_id,
            MindNode.user_id == user_id,
            MindNode.kind.in_(("canvas_note", "ref")),
            MindNode.deleted_at.is_(None),
        )
        .order_by(MindCanvasItem.z, MindCanvasItem.id)
        .limit(limit)
    )).all()
    result["nodes"] = [_node_summary(node, item, include_content=include_content) for item, node in rows]
    result["truncated"] = len(rows) >= limit
    if include_relations:
        node_ids = [node.id for _, node in rows]
        if node_ids:
            relations = (await db.execute(
                select(MindRelation).where(
                    MindRelation.user_id == user_id,
                    MindRelation.src_node_id.in_(node_ids),
                    MindRelation.dst_node_id.in_(node_ids),
                ).order_by(MindRelation.id)
            )).scalars().all()
            result["relations"] = [
                {
                    "relation_id": relation.id,
                    "source_node_id": relation.src_node_id,
                    "target_node_id": relation.dst_node_id,
                    "type": relation.rel_type,
                    "status": relation.status,
                }
                for relation in relations
            ]
        else:
            result["relations"] = []
    return result


def _canvas_type_condition(types: list[str] | None):
    selected = [item for item in (types or list(_CANVAS_TYPES)) if item in _CANVAS_TYPES]
    conditions = [MindNode.kind == "canvas_note"] if "canvas_note" in selected else []
    ref_types = [item for item in selected if item in _PLACEABLE_TYPES]
    if ref_types:
        conditions.append(and_(MindNode.kind == "ref", MindNode.ref_type.in_(ref_types)))
    return or_(*conditions) if conditions else false()


async def _mind_search_canvas(db, user_id, args: dict):
    canvas_id = args.get("canvas_id")
    if not isinstance(canvas_id, int):
        return {"error": "需要提供 canvas_id"}
    if await _get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    q = (args.get("q") or "").strip()
    raw_queries = args.get("queries")
    queries = raw_queries if isinstance(raw_queries, list) else None
    normalized = normalize_queries(q, queries)
    limit = _limit(args.get("limit"), 10)
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
    type_condition = _canvas_type_condition(args.get("types") if isinstance(args.get("types"), list) else None)
    if type_condition is not None:
        stmt = stmt.where(type_condition)
    if normalized:
        stmt = stmt.where(keyword_condition([MindNode.title, MindNode.content_plain], normalized, args.get("mode")))
    rows = (await db.execute(stmt)).all()
    return {
        "canvas_id": canvas_id,
        "query": q,
        "queries": normalized,
        "count": len(rows),
        "matches": [
            _node_summary(node, item, include_content=args.get("include_content") is True)
            for item, node in rows
        ],
        "truncated": len(rows) >= limit,
    }


def _placeable_summary(entity, ref_node: MindNode | None, item: MindCanvasItem | None, ref_type: str) -> dict[str, Any]:
    title = getattr(entity, "name", None) or getattr(entity, "display_name", None) or getattr(entity, "title", "")
    return {
        "kind": "ref",
        "ref_type": ref_type,
        "ref_id": entity.id,
        "title": title,
        "node_id": ref_node.id if ref_node else None,
        "already_placed": item is not None,
        "canvas_item_id": item.id if item else None,
    }


async def _mind_search_placeable_nodes(db, user_id, args: dict):
    q = (args.get("q") or "").strip()
    raw_queries = args.get("queries")
    queries = raw_queries if isinstance(raw_queries, list) else None
    normalized = normalize_queries(q, queries)
    if not normalized:
        return {"error": "需要提供搜索关键词 q 或 queries"}
    selected = [item for item in (args.get("types") or list(_PLACEABLE_TYPES)) if item in _PLACEABLE_TYPES]
    limit = _limit(args.get("limit"), 10)
    offset = args.get("offset", 0)
    offset = offset if isinstance(offset, int) and offset >= 0 else 0
    candidate_limit = offset + limit
    canvas_id = args.get("canvas_id") if isinstance(args.get("canvas_id"), int) else None
    if canvas_id is not None and await _get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    existing_stmt = select(MindNode).where(
        MindNode.user_id == user_id,
        MindNode.kind == "ref",
        MindNode.deleted_at.is_(None),
        MindNode.ref_type.in_(selected),
    )
    existing_nodes = (await db.execute(existing_stmt)).scalars().all()
    existing_by_key = {(node.ref_type, node.ref_id): node for node in existing_nodes}
    items_by_key: dict[tuple[str, int], MindCanvasItem] = {}
    if canvas_id is not None:
        item_rows = (await db.execute(
            select(MindCanvasItem, MindNode)
            .join(MindNode, MindNode.id == MindCanvasItem.node_id)
            .where(MindCanvasItem.canvas_id == canvas_id, MindCanvasItem.user_id == user_id, MindNode.kind == "ref")
        )).all()
        items_by_key = {(node.ref_type, node.ref_id): item for item, node in item_rows}

    matches: list[dict[str, Any]] = []
    if "project" in selected:
        rows = (await db.execute(select(Project).where(
            Project.user_id == user_id,
            keyword_condition([Project.name, Project.client], normalized, args.get("mode")),
        ).order_by(Project.updated_at.desc()).limit(candidate_limit))).scalars().all()
        matches.extend(_placeable_summary(row, existing_by_key.get(("project", row.id)), items_by_key.get(("project", row.id)), "project") for row in rows)
    if "file" in selected and len(matches) < candidate_limit:
        rows = (await db.execute(select(File).where(
            File.user_id == user_id,
            File.deleted_at.is_(None),
            keyword_condition([File.display_name, File.ext, File.stage_name], normalized, args.get("mode")),
        ).order_by(File.updated_at.desc()).limit(candidate_limit))).scalars().all()
        matches.extend(_placeable_summary(row, existing_by_key.get(("file", row.id)), items_by_key.get(("file", row.id)), "file") for row in rows)
    if "event" in selected and len(matches) < candidate_limit:
        rows = (await db.execute(select(CalendarEvent).where(
            CalendarEvent.user_id == user_id,
            keyword_condition([CalendarEvent.title, CalendarEvent.description, CalendarEvent.client], normalized, args.get("mode")),
        ).order_by(CalendarEvent.created_at.desc()).limit(candidate_limit))).scalars().all()
        matches.extend(_placeable_summary(row, existing_by_key.get(("event", row.id)), items_by_key.get(("event", row.id)), "event") for row in rows)
    page = matches[offset:offset + limit]
    return {
        "queries": normalized,
        "count": len(matches),
        "matches": page,
        "offset": offset,
        "limit": limit,
        "truncated": len(matches) > offset + limit,
    }


def _finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


async def _resolve_canvas_position(db, user_id, canvas: MindMap, node: MindNode, position: Any) -> tuple[float, float]:
    """把显式世界坐标或语义锚点转换成 MindCanvasItem 的世界坐标。"""
    position = position if isinstance(position, dict) else {}
    x, y = position.get("x"), position.get("y")
    if _finite_number(x) and _finite_number(y):
        return float(x), float(y)
    anchor = position.get("anchor", "auto")
    if anchor not in {"auto", "viewport_center", "viewport_top_left", "viewport_top_right", "viewport_bottom_left", "viewport_bottom_right", "near_node"}:
        raise ValueError("不支持的画布位置锚点")
    data = _json_object(canvas.data_json)
    camera = {key: data.get(key) for key in ("x", "y", "scale")}
    scale = float(camera["scale"]) if _finite_number(camera.get("scale")) and camera["scale"] > 0 else 1.0
    camera_x = float(camera["x"]) if _finite_number(camera.get("x")) else 0.0
    camera_y = float(camera["y"]) if _finite_number(camera.get("y")) else 0.0
    viewport = data.get("viewport") if isinstance(data.get("viewport"), dict) else None
    width = viewport.get("width") if viewport else None
    height = viewport.get("height") if viewport else None
    if anchor.startswith("viewport_"):
        if not (_finite_number(width) and _finite_number(height)):
            raise ValueError("画布尚未保存视口尺寸，暂时不能按当前视野定位")
        world_w, world_h = float(width) / scale, float(height) / scale
        world_x, world_y = -camera_x / scale, -camera_y / scale
        if anchor.endswith("center"):
            world_x += world_w / 2 - 110
            world_y += world_h / 2 - 60
        elif anchor.endswith("top_right"):
            world_x += world_w - 240
            world_y += 24
        elif anchor.endswith("bottom_left"):
            world_x += 24
            world_y += world_h - 144
        elif anchor.endswith("bottom_right"):
            world_x += world_w - 240
            world_y += world_h - 144
        else:
            world_x += 24
            world_y += 24
        return world_x + float(position.get("offset_x", 0) or 0), world_y + float(position.get("offset_y", 0) or 0)
    if anchor == "near_node":
        near_node_id = position.get("near_node_id")
        if not isinstance(near_node_id, int):
            raise ValueError("near_node 锚点必须提供 near_node_id")
        near_item = await db.scalar(select(MindCanvasItem).where(
            MindCanvasItem.canvas_id == canvas.id,
            MindCanvasItem.user_id == user_id,
            MindCanvasItem.node_id == near_node_id,
        ))
        if near_item is None:
            raise ValueError("找不到要靠近的画布节点")
        near_w = near_item.w or 220
        return float(near_item.x + near_w + 40 + (position.get("offset_x", 0) or 0)), float(near_item.y + (position.get("offset_y", 0) or 0))
    items = (await db.execute(select(MindCanvasItem).where(
        MindCanvasItem.canvas_id == canvas.id,
        MindCanvasItem.user_id == user_id,
    ).order_by(MindCanvasItem.x.desc(), MindCanvasItem.id.desc()).limit(1))).scalars().first()
    if items is None:
        return camera_x + 40, camera_y + 40
    return float(items.x + (items.w or 220) + 40), float(items.y)


async def _mind_create_canvas(db, user_id, args: dict):
    title = args.get("title")
    if not isinstance(title, str) or not title.strip():
        return {"error": "需要提供画布标题"}
    title = title.strip()
    if len(title) > 300:
        return {"error": "画布标题不能超过 300 个字符"}
    project_id = args.get("project_id")
    if project_id is not None:
        if not isinstance(project_id, int) or await db.scalar(select(Project).where(Project.id == project_id, Project.user_id == user_id)) is None:
            return {"error": "项目不存在"}
    canvas = await create_canvas(db, user_id, title, project_id)
    if canvas is None:
        return {"error": "项目不存在"}
    return {"canvas": {"canvas_id": canvas.id, "title": canvas.title, "project_id": canvas.project_id}}


async def _mind_create_canvas_note(db, user_id, args: dict):
    canvas_id = args.get("canvas_id")
    title = args.get("title") or "新便签"
    content = args.get("content") or ""
    color = args.get("color", "amber")
    if not isinstance(canvas_id, int) or await _get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    if not isinstance(title, str) or len(title.strip()) > 300 or not isinstance(content, str):
        return {"error": "便签标题或正文格式不正确"}
    try:
        color = validate_note_color(color)
    except ValueError as exc:
        return {"error": str(exc)}
    canvas = await _get_owned_canvas(db, user_id, canvas_id)
    x, y = await _resolve_canvas_position(db, user_id, canvas, None, args.get("position"))
    node, item = await create_canvas_note(
        db, user_id, canvas_id, title.strip() or "新便签", content, color, x, y,
    )
    return {"canvas_id": canvas_id, "node": _node_summary(node, item), "created": True}


async def _mind_add_canvas_node(db, user_id, args: dict):
    canvas_id = args.get("canvas_id")
    if not isinstance(canvas_id, int):
        return {"error": "需要提供 canvas_id"}
    canvas = await _get_owned_canvas(db, user_id, canvas_id)
    if canvas is None:
        return {"error": "画布不存在"}
    node_id = args.get("node_id")
    if isinstance(node_id, int):
        node = await db.scalar(select(MindNode).where(
            MindNode.id == node_id, MindNode.user_id == user_id, MindNode.kind == "ref", MindNode.deleted_at.is_(None),
        ))
        if node is None:
            return {"error": "只能把项目、文件或活动引用节点放入画布"}
    else:
        ref_type, ref_id = args.get("ref_type"), args.get("ref_id")
        if ref_type not in _PLACEABLE_TYPES or not isinstance(ref_id, int):
            return {"error": "需要提供 ref_type 和 ref_id，且类型必须是 project、file 或 event"}
        try:
            node, _ = await get_or_create_reference(db, user_id, ref_type, ref_id)
        except (ValueError, LookupError) as exc:
            await db.rollback()
            return {"error": str(exc)}
    existing = await get_canvas_item_by_node(db, user_id, canvas_id, node.id)
    if existing is not None:
        await db.refresh(node)
        return {"canvas_id": canvas_id, "node": _node_summary(node, existing), "created": False}
    x, y = await _resolve_canvas_position(db, user_id, canvas, node, args.get("position"))
    existing, created = await add_canvas_item(db, user_id, canvas_id, node, x, y)
    if not created:
        return {"canvas_id": canvas_id, "node": _node_summary(node, existing), "created": False}
    return {"canvas_id": canvas_id, "node": _node_summary(node, existing), "created": True}


async def _canvas_item(db, user_id, canvas_id: int, item_id: int):
    return await get_canvas_item(db, user_id, canvas_id, item_id)


async def _mind_update_canvas_node(db, user_id, args: dict):
    canvas_id, item_id = args.get("canvas_id"), args.get("item_id")
    if not isinstance(canvas_id, int) or not isinstance(item_id, int):
        return {"error": "需要提供 canvas_id 和 item_id"}
    if await _get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    item = await _canvas_item(db, user_id, canvas_id, item_id)
    if item is None:
        return {"error": "画布节点不存在"}
    fields = {}
    for key in ("x", "y", "w", "h"):
        if key in args:
            value = args[key]
            if not _finite_number(value) or (key in ("w", "h") and value <= 0):
                return {"error": f"{key} 必须是有效的正数" if key in ("w", "h") else f"{key} 必须是有效数字"}
            fields[key] = float(value)
    if "z" in args:
        if not isinstance(args["z"], int):
            return {"error": "z 必须是整数"}
        fields["z"] = args["z"]
    if "collapsed" in args:
        if not isinstance(args["collapsed"], bool):
            return {"error": "collapsed 必须是布尔值"}
        fields["collapsed"] = args["collapsed"]
    if not fields:
        return {"error": "至少提供一个要修改的布局字段"}
    item = await update_canvas_item(db, user_id, canvas_id, item_id, fields)
    node = await get_owned(db, MindNode, item.node_id, user_id)
    return {"canvas_id": canvas_id, "node": _node_summary(node, item), "updated": True}


async def _mind_remove_canvas_node(db, user_id, args: dict):
    canvas_id, item_id = args.get("canvas_id"), args.get("item_id")
    if not isinstance(canvas_id, int) or not isinstance(item_id, int):
        return {"error": "需要提供 canvas_id 和 item_id"}
    if await _get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    item = await _canvas_item(db, user_id, canvas_id, item_id)
    if item is None:
        return {"error": "画布节点不存在"}
    node_id = await remove_canvas_item(db, user_id, canvas_id, item_id)
    return {"canvas_id": canvas_id, "removed_item_id": item_id, "node_id": node_id, "node_preserved": True}


async def _mind_update_canvas_note(db, user_id, args: dict):
    node_id, version = args.get("node_id"), args.get("version")
    if not isinstance(node_id, int) or not isinstance(version, int):
        return {"error": "更新画布便签必须提供 node_id 和 version"}
    node = await db.scalar(select(MindNode).where(
        MindNode.id == node_id, MindNode.user_id == user_id,
        MindNode.kind == "canvas_note", MindNode.deleted_at.is_(None),
    ))
    if node is None:
        return {"error": "找不到这条画布便签"}
    fields = {}
    if "title" in args:
        if not isinstance(args["title"], str) or len(args["title"].strip()) > 300:
            return {"error": "便签标题格式不正确"}
        fields["title"] = args["title"].strip() or "新便签"
    if "content" in args:
        if not isinstance(args["content"], str):
            return {"error": "便签正文必须是文本"}
        fields["content_md"] = args["content"]
    if "color" in args:
        try:
            fields["color"] = validate_note_color(args["color"])
        except ValueError as exc:
            return {"error": str(exc)}
    if not fields:
        return {"error": "至少提供一个要修改的字段"}
    node = await update_canvas_note(db, user_id, node_id, version, fields)
    if node is False:
        return {"error": "画布便签已被其他端修改，请先重新读取后再更新"}
    return {"node": _node_summary(node), "updated": True}


async def _mind_delete_canvas_note(db, user_id, args: dict):
    from agent.security import confirm
    node_id, version = args.get("node_id"), args.get("version")
    if not isinstance(node_id, int) or not isinstance(version, int):
        return {"error": "删除画布便签必须提供 node_id 和 version"}
    node = await db.scalar(select(MindNode).where(
        MindNode.id == node_id, MindNode.user_id == user_id,
        MindNode.kind == "canvas_note", MindNode.deleted_at.is_(None),
    ))
    if node is None:
        return {"error": "找不到这条画布便签"}
    blocked = confirm.needs_confirmation(args, f"将删除画布便签「{node.title or '未命名'}」，并从画布移除其视图项", user_id)
    if blocked is not None:
        return blocked
    if not await delete_canvas_note(db, user_id, node_id, version):
        return {"error": "画布便签已被其他端修改，请先重新读取后再删除"}
    return {"deleted_node_id": node_id, "can_restore": True}


async def _mind_connect_nodes(db, user_id, args: dict):
    canvas_id, source_id, target_id = args.get("canvas_id"), args.get("source_node_id"), args.get("target_node_id")
    if not all(isinstance(value, int) for value in (canvas_id, source_id, target_id)):
        return {"error": "需要提供 canvas_id、source_node_id 和 target_node_id"}
    if await _get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    if source_id == target_id:
        return {"error": "节点不能连向自己"}
    relation, error = await connect_nodes(
        db, user_id, canvas_id, source_id, target_id, args.get("type") or "related",
    )
    if error:
        return {"error": error}
    return {"relation_id": relation.id, "source_node_id": relation.src_node_id, "target_node_id": relation.dst_node_id, "type": relation.rel_type, "created_or_reused": True}


async def _mind_disconnect_nodes(db, user_id, args: dict):
    from agent.security import confirm
    relation_id = args.get("relation_id")
    if not isinstance(relation_id, int):
        return {"error": "需要提供 relation_id"}
    relation = await get_owned(db, MindRelation, relation_id, user_id)
    if relation is None:
        return {"error": "关联不存在"}
    blocked = confirm.needs_confirmation(args, f"将删除节点关联 {relation.src_node_id} ↔ {relation.dst_node_id}", user_id)
    if blocked is not None:
        return blocked
    await disconnect_node_relation(db, user_id, relation_id)
    return {"deleted_relation_id": relation_id}


async def _mind_batch_canvas(db, user_id, args: dict):
    """在一个事务内批量放置引用节点、调整布局和创建连接。

    批量接口不接受删除类操作；引用节点/画布项/related 关系本身都有唯一约束，重试同一
    request_id 时会复用已有对象，从而保持可重放。任一操作失败都会回滚整批。
    """
    canvas_id = args.get("canvas_id")
    operations = args.get("operations")
    request_id = args.get("request_id")
    if not isinstance(canvas_id, int) or not isinstance(operations, list) or not operations:
        return {"error": "需要提供 canvas_id 和非空 operations"}
    if len(operations) > 20:
        return {"error": "单次最多批量处理 20 个操作"}
    if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 120:
        return {"error": "需要提供用于重试去重的 request_id"}
    canvas = await _get_owned_canvas(db, user_id, canvas_id)
    if canvas is None:
        return {"error": "画布不存在"}
    results = []
    try:
        for index, operation in enumerate(operations):
            if not isinstance(operation, dict):
                raise ValueError(f"第 {index + 1} 个操作格式不正确")
            kind = operation.get("kind")
            if kind == "add_node":
                ref_type, ref_id = operation.get("ref_type"), operation.get("ref_id")
                if ref_type not in _PLACEABLE_TYPES or not isinstance(ref_id, int):
                    raise ValueError(f"第 {index + 1} 个放置操作缺少有效引用")
                node, _ = await get_or_create_reference_node(db, user_id, ref_type, ref_id)
                item = await db.scalar(select(MindCanvasItem).where(
                    MindCanvasItem.canvas_id == canvas_id, MindCanvasItem.node_id == node.id,
                    MindCanvasItem.user_id == user_id,
                ))
                created = item is None
                if item is None:
                    x, y = await _resolve_canvas_position(db, user_id, canvas, node, operation.get("position"))
                    item = MindCanvasItem(user_id=user_id, canvas_id=canvas_id, node_id=node.id, x=x, y=y, z=0)
                    db.add(item)
                    await db.flush()
                results.append({"index": index, "kind": kind, "created": created, "node": _node_summary(node, item)})
            elif kind == "update_item":
                item_id = operation.get("item_id")
                if not isinstance(item_id, int):
                    raise ValueError(f"第 {index + 1} 个布局操作缺少 item_id")
                item = await _canvas_item(db, user_id, canvas_id, item_id)
                if item is None:
                    raise ValueError(f"第 {index + 1} 个布局操作找不到节点")
                fields = {key: operation[key] for key in ("x", "y", "w", "h", "z", "collapsed") if key in operation}
                for key in ("x", "y", "w", "h"):
                    if key in fields and (not _finite_number(fields[key]) or (key in ("w", "h") and fields[key] <= 0)):
                        raise ValueError(f"第 {index + 1} 个布局操作包含无效 {key}")
                if not fields:
                    raise ValueError(f"第 {index + 1} 个布局操作没有修改字段")
                await db.execute(update(MindCanvasItem).where(MindCanvasItem.id == item.id).values(**fields, updated_at=now_utc()))
                await db.flush()
                await db.refresh(item)
                node = await get_owned(db, MindNode, item.node_id, user_id)
                results.append({"index": index, "kind": kind, "updated": True, "node": _node_summary(node, item)})
            elif kind == "connect":
                source_id, target_id = operation.get("source_node_id"), operation.get("target_node_id")
                if not isinstance(source_id, int) or not isinstance(target_id, int):
                    raise ValueError(f"第 {index + 1} 个连接操作缺少节点")
                items = (await db.execute(select(MindCanvasItem).where(
                    MindCanvasItem.canvas_id == canvas_id, MindCanvasItem.user_id == user_id,
                    MindCanvasItem.node_id.in_((source_id, target_id)),
                ))).scalars().all()
                if {item.node_id for item in items} != {source_id, target_id}:
                    raise ValueError(f"第 {index + 1} 个连接操作的节点不在此画布")
                from app.core.mind import upsert_relation
                relation = await upsert_relation(db, user_id, source_id, target_id, rel_type="related")
                await db.flush()
                results.append({"index": index, "kind": kind, "relation_id": relation.id, "created_or_reused": True})
            else:
                raise ValueError(f"不支持的批量操作 {kind or '空操作'}；删除请使用单独工具确认")
        await db.commit()
    except Exception as exc:
        await db.rollback()
        return {"error": str(exc), "request_id": request_id, "rolled_back": True}
    return {"canvas_id": canvas_id, "request_id": request_id, "operations": results, "atomic": True}


class MindCanvasSkill(BaseSkill):
    name = "mind_canvas"
    tools = [
        Tool(
            name="mind_list_canvases", label="列出思维画布",
            description="列出当前用户有权限访问的思维画布摘要。用户没有明确画布时先调用，不要猜 canvas_id。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                    "offset": {"type": "integer", "minimum": 0},
                },
                "required": [],
            },
            handler=_mind_list_canvases,
        ),
        Tool(
            name="mind_get_canvas", label="读取思维画布",
            description="读取当前用户指定画布的节点摘要、连接和最后查看的 camera/viewport。完整正文只在用户明确要求时读取。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"},
                    "include_nodes": {"type": "boolean"},
                    "include_relations": {"type": "boolean"},
                    "include_content": {"type": "boolean"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                },
                "required": ["canvas_id"],
            },
            handler=_mind_get_canvas,
        ),
        Tool(
            name="mind_search_canvas", label="搜索画布内容",
            description="搜索指定画布中已有的画布便签、项目、文件和活动引用。普通时间流 note 不属于画布，不会返回。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"},
                    "q": {"type": "string"},
                    "queries": {"type": "array", "items": {"type": "string"}},
                    "types": {"type": "array", "items": {"type": "string", "enum": list(_CANVAS_TYPES)}},
                    "mode": {"type": "string", "enum": ["OR", "AND"]},
                    "include_content": {"type": "boolean"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                },
                "required": ["canvas_id"],
            },
            handler=_mind_search_canvas,
        ),
        Tool(
            name="mind_search_placeable_nodes", label="搜索可放置画布节点",
            description="搜索当前用户可访问、可以放入画布的项目、文件和日历活动。不会返回普通时间流 note，也不会因搜索自动创建引用节点。",
            input_schema={
                "type": "object",
                "properties": {
                    "q": {"type": "string"},
                    "queries": {"type": "array", "items": {"type": "string"}},
                    "types": {"type": "array", "items": {"type": "string", "enum": list(_PLACEABLE_TYPES)}},
                    "canvas_id": {"type": "integer"},
                    "mode": {"type": "string", "enum": ["OR", "AND"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                    "offset": {"type": "integer", "minimum": 0},
                },
                "required": [],
            },
            handler=_mind_search_placeable_nodes,
        ),
        Tool(
            name="mind_create_canvas", label="创建思维画布",
            description="按用户明确要求创建一张当前用户自己的思维画布；不能替用户猜测标题或项目。",
            input_schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "minLength": 1, "maxLength": 300},
                    "project_id": {"type": ["integer", "null"]},
                },
                "required": ["title"],
            },
            handler=_mind_create_canvas,
            mutates=True,
        ),
        Tool(
            name="mind_create_canvas_note", label="创建画布便签",
            description="在指定画布创建专属便签。它不会进入时间流 note；普通时间流笔记不能通过此工具放入画布。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"},
                    "title": {"type": "string", "maxLength": 300},
                    "content": {"type": "string"},
                    "color": {"type": "string", "enum": ["amber", "coral", "blue", "teal"]},
                    "position": {"type": "object"},
                },
                "required": ["canvas_id", "content"],
            },
            handler=_mind_create_canvas_note,
            mutates=True,
        ),
        Tool(
            name="mind_add_canvas_node", label="放置画布节点",
            description="把当前用户的项目、文件或日历活动引用放入画布。先使用 mind_search_placeable_nodes 解析对象；普通 note 和未知 node_id 不允许放入。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"},
                    "node_id": {"type": "integer"},
                    "ref_type": {"type": "string", "enum": list(_PLACEABLE_TYPES)},
                    "ref_id": {"type": "integer"},
                    "position": {"type": "object"},
                },
                "required": ["canvas_id"],
            },
            handler=_mind_add_canvas_node,
            mutates=True,
        ),
        Tool(
            name="mind_update_canvas_node", label="调整画布节点",
            description="调整已放置节点的位置、大小、层级或折叠状态；只改变画布视图，不改变原项目、文件或活动。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"}, "item_id": {"type": "integer"},
                    "x": {"type": "number"}, "y": {"type": "number"},
                    "w": {"type": "number", "exclusiveMinimum": 0}, "h": {"type": "number", "exclusiveMinimum": 0},
                    "z": {"type": "integer"}, "collapsed": {"type": "boolean"},
                },
                "required": ["canvas_id", "item_id"],
            },
            handler=_mind_update_canvas_node,
            mutates=True,
        ),
        Tool(
            name="mind_remove_canvas_node", label="移除画布节点",
            description="从指定画布移除节点视图；不会删除项目、文件、活动或画布便签正文。",
            input_schema={
                "type": "object",
                "properties": {"canvas_id": {"type": "integer"}, "item_id": {"type": "integer"}},
                "required": ["canvas_id", "item_id"],
            },
            handler=_mind_remove_canvas_node,
            mutates=True,
        ),
        Tool(
            name="mind_update_canvas_note", label="修改画布便签",
            description="按 node_id 和 version 修改画布专属便签；不能修改普通时间流 note。",
            input_schema={
                "type": "object",
                "properties": {
                    "node_id": {"type": "integer"}, "version": {"type": "integer"},
                    "title": {"type": "string", "maxLength": 300}, "content": {"type": "string"},
                    "color": {"type": "string", "enum": ["amber", "coral", "blue", "teal"]},
                },
                "required": ["node_id", "version"],
            },
            handler=_mind_update_canvas_note,
            mutates=True,
        ),
        Tool(
            name="mind_delete_canvas_note", label="删除画布便签",
            description="删除画布专属便签并移除其画布视图；执行前必须先展示影响并获得确认。",
            input_schema={
                "type": "object",
                "properties": {"node_id": {"type": "integer"}, "version": {"type": "integer"}, "confirm": {"type": "boolean"}, "confirm_token": {"type": "string"}},
                "required": ["node_id", "version"],
            },
            handler=_mind_delete_canvas_note,
            mutates=True,
            destructive=True,
        ),
        Tool(
            name="mind_connect_nodes", label="连接画布节点",
            description="连接同一张画布中已经放置的画布便签或业务引用节点；默认 related 且幂等。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"}, "source_node_id": {"type": "integer"},
                    "target_node_id": {"type": "integer"}, "type": {"type": "string", "enum": ["related"]},
                },
                "required": ["canvas_id", "source_node_id", "target_node_id"],
            },
            handler=_mind_connect_nodes,
            mutates=True,
        ),
        Tool(
            name="mind_disconnect_nodes", label="断开画布连接",
            description="删除一条画布节点关联；执行前必须先展示影响并获得确认。",
            input_schema={
                "type": "object",
                "properties": {"relation_id": {"type": "integer"}, "confirm": {"type": "boolean"}, "confirm_token": {"type": "string"}},
                "required": ["relation_id"],
            },
            handler=_mind_disconnect_nodes,
            mutates=True,
            destructive=True,
        ),
        Tool(
            name="mind_batch_canvas", label="批量编排画布",
            description="在一个事务内批量放置项目/文件/活动引用、调整布局和创建 related 连接。最多 20 个操作；失败会整批回滚，使用 request_id 重试可复用已有对象。删除类操作请改用单独工具确认。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"}, "request_id": {"type": "string", "maxLength": 120},
                    "operations": {"type": "array", "minItems": 1, "maxItems": 20, "items": {
                        "type": "object",
                        "properties": {
                            "kind": {"type": "string", "enum": ["add_node", "update_item", "connect"]},
                            "ref_type": {"type": "string", "enum": list(_PLACEABLE_TYPES)}, "ref_id": {"type": "integer"},
                            "item_id": {"type": "integer"}, "source_node_id": {"type": "integer"}, "target_node_id": {"type": "integer"},
                            "x": {"type": "number"}, "y": {"type": "number"}, "w": {"type": "number"}, "h": {"type": "number"},
                            "z": {"type": "integer"}, "collapsed": {"type": "boolean"}, "position": {"type": "object"},
                        },
                        "required": ["kind"],
                    }},
                },
                "required": ["canvas_id", "request_id", "operations"],
            },
            handler=_mind_batch_canvas,
            mutates=True,
        ),
    ]


MindCanvasSkill().register()
