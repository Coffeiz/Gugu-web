"""思维画布只读工具。

画布工具与时间流笔记工具分开：普通 ``note`` 不属于可放置对象；画布内搜索只返回
``canvas_note`` 和已经存在的业务引用节点。所有查询都按当前用户归属过滤，不接受模型
传入 user_id。
"""
from __future__ import annotations

import json
from typing import Any

from app.core.mind import validate_note_color
from app.services.mind_canvas import (
    add_canvas_item,
    connect_nodes,
    create_canvas,
    create_canvas_note,
    delete_canvas_note,
    disconnect_node_relation,
    get_canvas_item,
    get_canvas_item_by_node,
    get_canvas_node,
    get_canvas_relation,
    get_owned_canvas,
    get_owned_project,
    get_canvas_last_item,
    get_canvas_near_item,
    get_canvas_note,
    get_canvas_reference_node,
    get_or_create_reference,
    list_canvas_nodes,
    list_canvas_relations,
    relation_anchor_from_canvas,
    list_canvases,
    list_existing_canvas_reference_items,
    list_existing_reference_nodes,
    search_placeable_entities,
    search_canvas_nodes,
    batch_canvas_operations,
    remove_canvas_item,
    update_canvas_item,
    update_canvas_note,
    update_relation_anchor,
)
from app.search.query import normalize_queries
from agent.tools.base import BaseSkill, Tool

_MAX_RESULTS = 20
_PLACEABLE_TYPES = ("project", "file", "event")
_CANVAS_TYPES = ("canvas_note", "project", "file", "event")
_DEFAULT_ITEM_SIZES = {
    "canvas_note": (244, 148),
    "project": (240, 120),
    "file": (156, 140),
    "event": (220, 96),
}

# 画布布局安全约束，供语义锚点和 Agent 排布提示共同使用。
_SAFE_EDGE_GAP = 150
_SAFE_CENTER_DISTANCE = 750


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


def _view_summary(canvas: Any) -> dict[str, Any]:
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


def _node_summary(node: Any, item: Any = None, *, include_content: bool = False) -> dict[str, Any]:
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
        default_w, default_h = _DEFAULT_ITEM_SIZES.get(
            "canvas_note" if node.kind == "canvas_note" else node.ref_type,
            _DEFAULT_ITEM_SIZES["event"],
        )
        effective_w = item.w if item.w is not None else default_w
        effective_h = item.h if item.h is not None else default_h
        result.update({
            "item_id": item.id,
            "position": {"x": item.x, "y": item.y},
            "size": {"w": item.w, "h": item.h},
            "layout": {
                "effective_size": {"w": effective_w, "h": effective_h},
                "default_size": {"w": default_w, "h": default_h},
                "size_source": "explicit" if item.w is not None or item.h is not None else "default",
                "recommended_gap": _SAFE_EDGE_GAP,
                "recommended_center_distance": _SAFE_CENTER_DISTANCE,
            },
            "collapsed": item.collapsed,
            "z": item.z,
        })
    if include_content:
        result["content_md"] = node.content_md
        result["content_plain"] = node.content_plain
    return result


async def _mind_list_canvases(db, user_id, args: dict):
    limit = _limit(args.get("limit"), 20)
    offset = args.get("offset", 0)
    offset = offset if isinstance(offset, int) and offset >= 0 else 0
    project_id = args.get("project_id")
    rows, total, counts = await list_canvases(
        db, user_id, project_id=project_id, limit=limit, offset=offset,
    )
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
    canvas = await get_owned_canvas(db, user_id, canvas_id)
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
    rows = await list_canvas_nodes(db, user_id, canvas.id, limit=limit)
    result["nodes"] = [_node_summary(node, item, include_content=include_content) for item, node in rows]
    result["truncated"] = len(rows) >= limit
    if include_relations:
        node_ids = [node.id for _, node in rows]
        if node_ids:
            relations = await list_canvas_relations(db, user_id, node_ids)
            result["relations"] = [
                {
                    "relation_id": relation.id,
                    "source_node_id": relation.src_node_id,
                    "target_node_id": relation.dst_node_id,
                    "type": relation.rel_type,
                    "status": relation.status,
                    **(relation_anchor_from_canvas(canvas, relation.id) or {}),
                }
                for relation in relations
            ]
        else:
            result["relations"] = []
    return result


async def _mind_search_canvas(db, user_id, args: dict):
    canvas_id = args.get("canvas_id")
    if not isinstance(canvas_id, int):
        return {"error": "需要提供 canvas_id"}
    if await get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    q = (args.get("q") or "").strip()
    raw_queries = args.get("queries")
    queries = raw_queries if isinstance(raw_queries, list) else None
    normalized = normalize_queries(q, queries)
    limit = _limit(args.get("limit"), 10)
    selected = [item for item in (args.get("types") or list(_CANVAS_TYPES)) if item in _CANVAS_TYPES]
    rows = await search_canvas_nodes(
        db, user_id, canvas_id, selected=selected, normalized=normalized,
        mode=args.get("mode"), limit=limit,
    )
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


def _placeable_summary(entity, ref_node: Any, item: Any, ref_type: str) -> dict[str, Any]:
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
    if canvas_id is not None and await get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    existing_nodes = await list_existing_reference_nodes(db, user_id, selected)
    existing_by_key = {(node.ref_type, node.ref_id): node for node in existing_nodes}
    items_by_key: dict[tuple[str, int], Any] = {}
    if canvas_id is not None:
        item_rows = await list_existing_canvas_reference_items(db, user_id, canvas_id)
        items_by_key = {(node.ref_type, node.ref_id): item for item, node in item_rows}

    matches: list[dict[str, Any]] = []
    for ref_type, row in await search_placeable_entities(
        db, user_id, selected, normalized, args.get("mode"), candidate_limit,
    ):
        matches.append(_placeable_summary(
            row, existing_by_key.get((ref_type, row.id)), items_by_key.get((ref_type, row.id)), ref_type,
        ))
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


async def _resolve_canvas_position(db, user_id, canvas: Any, node: Any, position: Any) -> tuple[float, float]:
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
        near_item = await get_canvas_near_item(db, user_id, canvas.id, near_node_id)
        if near_item is None:
            raise ValueError("找不到要靠近的画布节点")
        near_w = near_item.w or 220
        return float(near_item.x + near_w + _SAFE_EDGE_GAP + (position.get("offset_x", 0) or 0)), float(near_item.y + (position.get("offset_y", 0) or 0))
    items = await get_canvas_last_item(db, user_id, canvas.id)
    if items is None:
        return camera_x + 40, camera_y + 40
    return float(items.x + (items.w or 220) + _SAFE_EDGE_GAP), float(items.y)


async def _mind_create_canvas(db, user_id, args: dict):
    title = args.get("title")
    if not isinstance(title, str) or not title.strip():
        return {"error": "需要提供画布标题"}
    title = title.strip()
    if len(title) > 300:
        return {"error": "画布标题不能超过 300 个字符"}
    project_id = args.get("project_id")
    if project_id is not None:
        if not isinstance(project_id, int) or await get_owned_project(db, user_id, project_id) is None:
            return {"error": "项目不存在"}
    canvas = await create_canvas(db, user_id, title, project_id, commit=True)
    if canvas is None:
        return {"error": "项目不存在"}
    return {"canvas": {"canvas_id": canvas.id, "title": canvas.title, "project_id": canvas.project_id}}


async def _mind_create_canvas_note(db, user_id, args: dict):
    canvas_id = args.get("canvas_id")
    title = args.get("title") or "新便签"
    content = args.get("content") or ""
    color = args.get("color", "amber")
    if not isinstance(canvas_id, int) or await get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    if not isinstance(title, str) or len(title.strip()) > 300 or not isinstance(content, str):
        return {"error": "便签标题或正文格式不正确"}
    try:
        color = validate_note_color(color)
    except ValueError as exc:
        return {"error": str(exc)}
    canvas = await get_owned_canvas(db, user_id, canvas_id)
    x, y = await _resolve_canvas_position(db, user_id, canvas, None, args.get("position"))
    node, item = await create_canvas_note(
        db, user_id, canvas_id, title.strip() or "新便签", content, color, x, y, commit=True,
    )
    return {"canvas_id": canvas_id, "node": _node_summary(node, item), "created": True}


async def _mind_add_canvas_node(db, user_id, args: dict):
    canvas_id = args.get("canvas_id")
    if not isinstance(canvas_id, int):
        return {"error": "需要提供 canvas_id"}
    canvas = await get_owned_canvas(db, user_id, canvas_id)
    if canvas is None:
        return {"error": "画布不存在"}
    node_id = args.get("node_id")
    if isinstance(node_id, int):
        node = await get_canvas_reference_node(db, user_id, node_id)
        if node is None:
            return {"error": "只能把项目、文件或活动引用节点放入画布"}
    else:
        ref_type, ref_id = args.get("ref_type"), args.get("ref_id")
        if ref_type not in _PLACEABLE_TYPES or not isinstance(ref_id, int):
            return {"error": "需要提供 ref_type 和 ref_id，且类型必须是 project、file 或 event"}
        try:
            node, _ = await get_or_create_reference(db, user_id, ref_type, ref_id)
        except (ValueError, LookupError) as exc:
            return {"error": str(exc)}
    existing = await get_canvas_item_by_node(db, user_id, canvas_id, node.id)
    if existing is not None:
        return {"canvas_id": canvas_id, "node": _node_summary(node, existing), "created": False}
    x, y = await _resolve_canvas_position(db, user_id, canvas, node, args.get("position"))
    existing, created = await add_canvas_item(db, user_id, canvas_id, node, x, y, commit=True)
    if not created:
        return {"canvas_id": canvas_id, "node": _node_summary(node, existing), "created": False}
    return {"canvas_id": canvas_id, "node": _node_summary(node, existing), "created": True}


async def _mind_update_canvas_node(db, user_id, args: dict):
    canvas_id, item_id = args.get("canvas_id"), args.get("item_id")
    if not isinstance(canvas_id, int) or not isinstance(item_id, int):
        return {"error": "需要提供 canvas_id 和 item_id"}
    if await get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    item = await get_canvas_item(db, user_id, canvas_id, item_id)
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
    item = await update_canvas_item(db, user_id, canvas_id, item_id, fields, commit=True)
    node = await get_canvas_node(db, user_id, item.node_id)
    return {"canvas_id": canvas_id, "node": _node_summary(node, item), "updated": True}


async def _mind_remove_canvas_node(db, user_id, args: dict):
    canvas_id, item_id = args.get("canvas_id"), args.get("item_id")
    if not isinstance(canvas_id, int) or not isinstance(item_id, int):
        return {"error": "需要提供 canvas_id 和 item_id"}
    if await get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    item = await get_canvas_item(db, user_id, canvas_id, item_id)
    if item is None:
        return {"error": "画布节点不存在"}
    node_id = await remove_canvas_item(db, user_id, canvas_id, item_id, commit=True)
    return {"canvas_id": canvas_id, "removed_item_id": item_id, "node_id": node_id, "node_preserved": True}


async def _mind_update_canvas_note(db, user_id, args: dict):
    node_id, version = args.get("node_id"), args.get("version")
    if not isinstance(node_id, int) or not isinstance(version, int):
        return {"error": "更新画布便签必须提供 node_id 和 version"}
    node = await get_canvas_note(db, user_id, node_id)
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
    node = await update_canvas_note(db, user_id, node_id, version, fields, commit=True)
    if node is False:
        return {"error": "画布便签已被其他端修改，请先重新读取后再更新"}
    return {"node": _node_summary(node), "updated": True}


async def _mind_delete_canvas_note(db, user_id, args: dict):
    from agent.security import confirm
    node_id, version = args.get("node_id"), args.get("version")
    if not isinstance(node_id, int) or not isinstance(version, int):
        return {"error": "删除画布便签必须提供 node_id 和 version"}
    node = await get_canvas_note(db, user_id, node_id)
    if node is None:
        return {"error": "找不到这条画布便签"}
    blocked = confirm.needs_confirmation(args, f"将删除画布便签「{node.title or '未命名'}」，并从画布移除其视图项", user_id)
    if blocked is not None:
        return blocked
    if not await delete_canvas_note(db, user_id, node_id, version, commit=True):
        return {"error": "画布便签已被其他端修改，请先重新读取后再删除"}
    return {"deleted_node_id": node_id, "can_restore": True}


async def _mind_connect_nodes(db, user_id, args: dict):
    canvas_id, source_id, target_id = args.get("canvas_id"), args.get("source_node_id"), args.get("target_node_id")
    if not all(isinstance(value, int) for value in (canvas_id, source_id, target_id)):
        return {"error": "需要提供 canvas_id、source_node_id 和 target_node_id"}
    if await get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    if source_id == target_id:
        return {"error": "节点不能连向自己"}
    source_side, target_side = args.get("source_side"), args.get("target_side")
    if (source_side is None) != (target_side is None):
        return {"error": "source_side 和 target_side 必须同时提供"}
    if ((source_side is not None and source_side not in {"left", "right"})
            or (target_side is not None and target_side not in {"left", "right"})):
        return {"error": "连接点只能是 left 或 right"}
    relation, error = await connect_nodes(
        db, user_id, canvas_id, source_id, target_id, args.get("type") or "related", commit=True,
    )
    if error:
        return {"error": error}
    anchor = relation_anchor_from_canvas(await get_owned_canvas(db, user_id, canvas_id), relation.id)
    if source_side is not None:
        # related 关系可能按节点 id 归一，端点必须跟返回的 source/target 字段保持一致。
        if source_id == relation.src_node_id:
            normalized = (source_side, target_side)
        else:
            normalized = (target_side, source_side)
        anchor = await update_relation_anchor(db, user_id, canvas_id, relation, *normalized, commit=True)
    return {"relation_id": relation.id, "source_node_id": relation.src_node_id, "target_node_id": relation.dst_node_id, "type": relation.rel_type, "created_or_reused": True, **(anchor or {})}


async def _mind_update_relation_anchor(db, user_id, args: dict):
    canvas_id, relation_id = args.get("canvas_id"), args.get("relation_id")
    source_side, target_side = args.get("source_side"), args.get("target_side")
    if not isinstance(canvas_id, int) or not isinstance(relation_id, int):
        return {"error": "需要提供 canvas_id 和 relation_id"}
    if source_side not in {"left", "right"} or target_side not in {"left", "right"}:
        return {"error": "source_side 和 target_side 只能是 left 或 right"}
    relation = await get_canvas_relation(db, user_id, relation_id)
    if relation is None:
        return {"error": "关联不存在"}
    anchor = await update_relation_anchor(db, user_id, canvas_id, relation, source_side, target_side, commit=True)
    if anchor is None:
        return {"error": "关联的两个节点必须都位于指定画布"}
    return {"relation_id": relation.id, "source_node_id": relation.src_node_id, "target_node_id": relation.dst_node_id, **anchor, "updated": True}


async def _mind_disconnect_nodes(db, user_id, args: dict):
    from agent.security import confirm
    relation_id = args.get("relation_id")
    if not isinstance(relation_id, int):
        return {"error": "需要提供 relation_id"}
    relation = await get_canvas_relation(db, user_id, relation_id)
    if relation is None:
        return {"error": "关联不存在"}
    blocked = confirm.needs_confirmation(args, f"将删除节点关联 {relation.src_node_id} ↔ {relation.dst_node_id}", user_id)
    if blocked is not None:
        return blocked
    await disconnect_node_relation(db, user_id, relation_id, commit=True)
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
    canvas = await get_owned_canvas(db, user_id, canvas_id)
    if canvas is None:
        return {"error": "画布不存在"}
    return await batch_canvas_operations(
        db, user_id, canvas, operations, request_id,
        resolve_position=_resolve_canvas_position,
        summarize=_node_summary,
    )
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
            description="读取当前用户指定画布的节点摘要、连接和最后查看的 camera/viewport。节点带有 layout.effective_size、layout.default_size 与推荐间距，排布时按实际尺寸避让。完整正文只在用户明确要求时读取。",
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
            description="把当前用户的项目、文件或日历活动引用放入画布。position.x/y 是卡片左上角；放置前必须按已有节点的 layout.effective_size 计算矩形，节点在上、下、左、右任一方向相邻时都不能重叠，并默认保留至少 150px 边缘间距；采用中心点排布时至少保持 750px 中心距。先使用 mind_search_placeable_nodes 解析对象；普通 note 和未知 node_id 不允许放入。",
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
            description="调整已放置节点的位置、大小、层级或折叠状态；按其它节点的 layout.effective_size 在上、下、左、右任一方向留出至少 150px 边缘间距，采用中心点排布时至少保持 750px 中心距，避免重叠；只改变画布视图，不改变原项目、文件或活动。",
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
            description="连接同一张画布中已经放置的画布便签或业务引用节点；默认 related 且幂等。可选 source_side/target_side 指定两端连接点，未指定时沿用已有端点或由画布自动决定。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"}, "source_node_id": {"type": "integer"},
                    "target_node_id": {"type": "integer"}, "type": {"type": "string", "enum": ["related"]},
                    "source_side": {"type": "string", "enum": ["left", "right"]},
                    "target_side": {"type": "string", "enum": ["left", "right"]},
                },
                "required": ["canvas_id", "source_node_id", "target_node_id"],
            },
            handler=_mind_connect_nodes,
            mutates=True,
        ),
        Tool(
            name="mind_update_relation_anchor", label="调整画布连接点",
            description="修改指定画布关系两端使用的连接点。source_side/target_side 分别对应读取结果中的 source_node_id/target_node_id；只改变画布视图，不改变关系语义。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"}, "relation_id": {"type": "integer"},
                    "source_side": {"type": "string", "enum": ["left", "right"]},
                    "target_side": {"type": "string", "enum": ["left", "right"]},
                },
                "required": ["canvas_id", "relation_id", "source_side", "target_side"],
            },
            handler=_mind_update_relation_anchor,
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
            description="在一个事务内批量放置项目/文件/活动引用、调整布局和创建 related 连接。批量放置仍必须按每个节点的 layout.effective_size 做矩形避让，节点在上、下、左、右任一方向相邻时都不得重叠且默认留至少 150px 边缘间距；采用中心点排布时至少保持 750px 中心距。最多 20 个操作；失败会整批回滚，使用 request_id 重试可复用已有对象。删除类操作请改用单独工具确认。",
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
                            "source_side": {"type": "string", "enum": ["left", "right"]}, "target_side": {"type": "string", "enum": ["left", "right"]},
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
