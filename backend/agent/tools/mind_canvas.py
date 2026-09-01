"""思维画布只读工具。

画布工具与时间流笔记工具分开：普通 ``note`` 不属于可放置对象；画布内搜索只返回
``canvas_note`` 和已经存在的业务引用节点。所有查询都按当前用户归属过滤，不接受模型
传入 user_id。
"""
from __future__ import annotations

import json
from typing import Any

from app.core.mind import validate_note_color
from app.services.canvas.layout_engine import canvas_layout, parse_canvas_data
from app.services.canvas.service import (
    add_canvas_item,
    count_canvas_nodes,
    connect_nodes,
    create_canvas,
    create_canvas_note,
    delete_canvas,
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
    list_canvas_relations_for_canvas,
    relation_anchor_from_canvas,
    list_canvases,
    list_existing_canvas_reference_items,
    list_existing_reference_nodes,
    search_placeable_entities,
    search_canvas_nodes,
    remove_canvas_item,
    update_canvas_item,
    update_canvas_note,
    update_relation_anchor,
)
from app.services.canvas.batch import batch_canvas_operations
from app.search.query import normalize_queries
from agent.tools.base import BaseSkill, Tool

_MAX_RESULTS = 20
_MAX_MUTATIONS = 20
_PLACEABLE_TYPES = ("project", "file", "event")
_CANVAS_TYPES = ("canvas_note", "project", "file", "event")

_CANVAS_LAYOUT_PROPERTIES = {
    "item_id": {"type": "integer"},
    "x": {"type": "number"},
    "y": {"type": "number"},
    "z": {"type": "integer"},
    "collapsed": {"type": "boolean"},
}
_CANVAS_UPDATE_ITEM_SCHEMA = {
    "type": "object",
    "properties": _CANVAS_LAYOUT_PROPERTIES,
    "required": ["item_id"],
    "anyOf": [{"required": [field]} for field in ("x", "y", "z", "collapsed")],
    "additionalProperties": False,
}
_CANVAS_UPDATE_NODE_SCHEMA = {
    "type": "object",
    "properties": {
        "canvas_id": {"type": "integer"},
        **_CANVAS_LAYOUT_PROPERTIES,
        "updates": {"type": "array", "minItems": 1, "maxItems": _MAX_MUTATIONS, "items": _CANVAS_UPDATE_ITEM_SCHEMA},
    },
    "required": ["canvas_id"],
    "oneOf": [
        {
            "required": ["item_id"],
            "not": {"required": ["updates"]},
            "anyOf": [{"required": [field]} for field in ("x", "y", "z", "collapsed")],
        },
        {
            "required": ["updates"],
            "not": {"anyOf": [{"required": [field]} for field in ("item_id", "x", "y", "z", "collapsed")]},
        },
    ],
}
_CANVAS_NOTE_UPDATE_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "node_id": {"type": "integer"},
        "title": {"type": "string", "maxLength": 300},
        "content": {"type": "string"},
        "color": {"type": "string", "enum": ["amber", "coral", "blue", "teal"]},
    },
    "required": ["node_id"],
    "anyOf": [{"required": [field]} for field in ("title", "content", "color")],
    "additionalProperties": False,
}
_CANVAS_NOTE_CREATE_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "maxLength": 300},
        "content": {"type": "string"},
        "color": {"type": "string", "enum": ["amber", "coral", "blue", "teal"]},
        "position": {"type": "object"},
    },
    "additionalProperties": False,
}
_CANVAS_ADD_NODE_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "node_id": {"type": "integer"},
        "ref_type": {"type": "string", "enum": list(_PLACEABLE_TYPES)},
        "ref_id": {"type": "integer"},
        "position": {"type": "object"},
    },
    "oneOf": [
        {"required": ["node_id"], "not": {"anyOf": [{"required": ["ref_type"]}, {"required": ["ref_id"]}]}},
        {"required": ["ref_type", "ref_id"], "not": {"required": ["node_id"]}},
    ],
    "additionalProperties": False,
}


def _json_object(raw: str | None) -> dict[str, Any]:
    return parse_canvas_data(raw)


def _limit(value: Any, default: int = 10) -> int:
    if not isinstance(value, int):
        return default
    return max(1, min(value, _MAX_RESULTS))


def _relation_anchor_audit(
    relation: Any,
    node_by_id: dict[int, dict[str, Any]],
    canvas: Any,
) -> dict[str, Any]:
    """为模型提供基于卡片位置的连接点核对信息。

    related 关系的节点 ID 会在服务层归一，不能把 ID 顺序当成画面方向。
    这里仅给出几何上的默认建议；已保存的同侧端点仍标记为 custom，保留
    loop 等有意布局，不在读取阶段擅自改线。
    """
    source = node_by_id.get(relation.src_node_id)
    target = node_by_id.get(relation.dst_node_id)
    current = relation_anchor_from_canvas(canvas, relation.id)
    audit: dict[str, Any] = {
        "relation_id": relation.id,
        "source_node_id": relation.src_node_id,
        "target_node_id": relation.dst_node_id,
        "current": current or {"source_side": None, "target_side": None},
    }
    if source is None or target is None:
        audit["status"] = "incomplete"
        audit["reason"] = "关系两端没有同时出现在本次快照中"
        return audit

    def center(node: dict[str, Any]) -> tuple[float, float]:
        position = node.get("position") or {}
        size = (node.get("layout") or {}).get("effective_size") or {}
        return (
            float(position.get("x", 0)) + float(size.get("w", 0)) / 2,
            float(position.get("y", 0)) + float(size.get("h", 0)) / 2,
        )

    source_center = center(source)
    target_center = center(target)
    recommended_sides = _recommended_relation_sides(source, target)
    expected = {"source_side": recommended_sides[0], "target_side": recommended_sides[1]}
    audit["source"] = {"node_id": relation.src_node_id, "center": {"x": source_center[0], "y": source_center[1]}}
    audit["target"] = {"node_id": relation.dst_node_id, "center": {"x": target_center[0], "y": target_center[1]}}
    audit["recommended"] = expected
    if current is None:
        audit["status"] = "implicit"
    elif current == expected:
        audit["status"] = "aligned"
    else:
        audit["status"] = "custom"
        audit["reason"] = "当前端点与按卡片水平投影计算的默认端点不同，可能是有意的回环布局"
    return audit


def _mutation_entries(args: dict, plural_key: str) -> tuple[list[dict[str, Any]], bool, str | None]:
    """把单项参数统一成批量条目，同时保持旧的单项返回契约。"""
    raw = args.get(plural_key)
    if raw is None:
        return [args], False, None
    if not isinstance(raw, list) or not raw:
        return [], True, f"{plural_key} 必须是非空数组"
    if len(raw) > _MAX_MUTATIONS:
        return [], True, f"单次最多处理 {_MAX_MUTATIONS} 个操作"
    entries = [entry for entry in raw if isinstance(entry, dict)]
    if len(entries) != len(raw):
        return [], True, f"{plural_key} 中每一项都必须是对象"
    return entries, True, None


def _reject_card_size(entry: dict[str, Any]) -> None:
    """Agent 不直接控制卡片尺寸，尺寸由系统按节点类型统一决定。"""
    if "w" in entry or "h" in entry:
        raise ValueError("画布卡片大小由系统管理，工具不支持修改 w/h")
    position = entry.get("position")
    if isinstance(position, dict) and ("w" in position or "h" in position):
        raise ValueError("画布卡片大小由系统管理，工具不支持在 position 中传入 w/h")


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
        default_w, default_h = canvas_layout.default_size(node)
        effective_w, effective_h = canvas_layout.effective_size(node, item)
        result.update({
            "item_id": item.id,
            "position": {"x": item.x, "y": item.y},
            "size": {"w": item.w, "h": item.h},
            "layout": {
                "effective_size": {"w": effective_w, "h": effective_h},
                "default_size": {"w": default_w, "h": default_h},
                "size_source": "explicit" if item.w is not None or item.h is not None else "default",
                "recommended_gap": canvas_layout.SAFE_EDGE_GAP,
                "recommended_center_distance": canvas_layout.SAFE_CENTER_DISTANCE,
            },
            "collapsed": item.collapsed,
            "z": item.z,
        })
    if include_content:
        result["content_md"] = node.content_md
        result["content_plain"] = node.content_plain
    return result


def _recommended_relation_sides(source: dict[str, Any], target: dict[str, Any]) -> tuple[str, str]:
    """按卡片水平投影建议端点，不把节点 ID 当成布局顺序。"""
    source_x = float((source.get("position") or {}).get("x", 0))
    target_x = float((target.get("position") or {}).get("x", 0))
    source_w = float(((source.get("layout") or {}).get("effective_size") or {}).get("w", 0))
    target_w = float(((target.get("layout") or {}).get("effective_size") or {}).get("w", 0))
    source_right = source_x + source_w
    target_right = target_x + target_w
    if source_right <= target_x:
        return "right", "left"
    if target_right <= source_x:
        return "left", "right"
    # 水平投影重叠通常表示上下编排；同侧出线能让多张竖排卡片共用一条外侧走线。
    side = "right" if target_x + target_w / 2 >= source_x + source_w / 2 else "left"
    return side, side


async def _canvas_list(db, user_id, args: dict):
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


async def _canvas_get(db, user_id, args: dict):
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
    offset = args.get("offset", 0)
    offset = offset if isinstance(offset, int) and offset >= 0 else 0
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
    total_nodes = await count_canvas_nodes(db, user_id, canvas.id)
    visible_rows = await list_canvas_nodes(db, user_id, canvas.id, limit=limit, offset=offset)
    result["nodes"] = [_node_summary(node, item, include_content=include_content) for item, node in visible_rows]
    has_next_page = offset + len(visible_rows) < total_nodes
    result["pagination"] = {
        "offset": offset,
        "limit": limit,
        "total": total_nodes,
        "next_offset": offset + limit if has_next_page else None,
    }
    result["truncated"] = has_next_page
    if include_relations:
        relations = await list_canvas_relations_for_canvas(db, user_id, canvas.id)
        node_by_id = {
            node.id: _node_summary(node, item, include_content=False)
            for item, node in visible_rows
        }
        result["relation_scope"] = "canvas"
        result["relation_audit_scope"] = "visible_nodes"
        result["relation_count"] = len(relations)
        if relations:
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
            result["relation_audit"] = [
                _relation_anchor_audit(relation, node_by_id, canvas)
                for relation in relations
            ]
        else:
            result["relations"] = []
            result["relation_audit"] = []
    return result


async def _canvas_search(db, user_id, args: dict):
    canvas_id = args.get("canvas_id")
    if not isinstance(canvas_id, int):
        return {"error": "需要提供 canvas_id"}
    if await get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    q = (args.get("query") or args.get("q") or "").strip()
    raw_queries = args.get("queries")
    queries = raw_queries if isinstance(raw_queries, list) else None
    normalized = normalize_queries(q, queries)
    limit = _limit(args.get("limit"), 10)
    selected = [item for item in (args.get("types") or list(_CANVAS_TYPES)) if item in _CANVAS_TYPES]
    rows = await search_canvas_nodes(
        db, user_id, canvas_id, selected=selected, normalized=normalized,
        mode=args.get("mode"), limit=limit + 1,
    )
    return {
        "canvas_id": canvas_id,
        "query": q,
        "queries": normalized,
        "count": len(rows),
        "matches": [
            _node_summary(node, item, include_content=args.get("include_content") is True)
            for item, node in rows[:limit]
        ],
        "truncated": len(rows) > limit,
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


async def _canvas_search_placeable(db, user_id, args: dict):
    q = (args.get("query") or args.get("q") or "").strip()
    raw_queries = args.get("queries")
    queries = raw_queries if isinstance(raw_queries, list) else None
    normalized = normalize_queries(q, queries)
    if not normalized:
        return {"error": "需要提供搜索关键词 query 或 queries"}
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
        db, user_id, selected, normalized, args.get("mode"), candidate_limit + 1,
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
    near_item = None
    if position.get("anchor") == "near_node":
        near_node_id = position.get("near_node_id")
        if not isinstance(near_node_id, int):
            raise ValueError("near_node 锚点必须提供 near_node_id")
        near_item = await get_canvas_near_item(db, user_id, canvas.id, near_node_id)
    last_item = await get_canvas_last_item(db, user_id, canvas.id) if position.get("anchor", "auto") == "auto" else None
    return canvas_layout.resolve_position(position, _json_object(canvas.data_json), last_item=last_item, near_item=near_item)


async def _canvas_create(db, user_id, args: dict):
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
    canvas = await create_canvas(db, user_id, title, project_id, commit=False)
    if canvas is None:
        return {"error": "项目不存在"}
    return {"canvas": {"canvas_id": canvas.id, "title": canvas.title, "project_id": canvas.project_id}}


async def _canvas_delete(db, user_id, args: dict):
    from agent.security import confirm
    canvas_ids = args.get("canvas_ids")
    if canvas_ids is not None:
        if not isinstance(canvas_ids, list) or not canvas_ids or len(canvas_ids) > 20:
            return {"error": "canvas_ids 必须是 1-20 个画布 id"}
        canvases = []
        for canvas_id in canvas_ids:
            canvas = await get_owned_canvas(db, user_id, canvas_id)
            if canvas is None:
                return {"error": f"画布 {canvas_id} 不存在"}
            canvases.append(canvas)
        names = "、".join((c.title or "未命名画布") for c in canvases[:8]) + (f"等 {len(canvases)} 个" if len(canvases) > 8 else "")
        blocked = confirm.needs_confirmation(args, f"将删除画布：{names}，共 {len(canvases)} 个，包含便签、引用节点和连接关系", user_id,
                                             identity=f"canvas_delete:canvas_ids={sorted(canvas_ids)}")
        if blocked is not None:
            return blocked
        for canvas in canvases:
            if not await delete_canvas(db, user_id, canvas.id, commit=False):
                return {"error": f"画布 {canvas.id} 删除失败"}
        await db.commit()
        return {"success": True, "deleted_count": len(canvases), "deleted_canvas_ids": [c.id for c in canvases]}
    canvas_id = args.get("canvas_id")
    if not isinstance(canvas_id, int):
        return {"error": "需要提供 canvas_id"}
    canvas = await get_owned_canvas(db, user_id, canvas_id)
    if canvas is None:
        return {"error": "画布不存在"}
    title = canvas.title or "未命名画布"
    blocked = confirm.needs_confirmation(args, f"将删除画布「{title}」（含所有便签、引用节点和连接关系）", user_id)
    if blocked is not None:
        return blocked
    ok = await delete_canvas(db, user_id, canvas_id, commit=True)
    if not ok:
        return {"error": "删除失败"}
    return {"deleted": True, "canvas_id": canvas_id, "title": title}


async def _canvas_create_note(db, user_id, args: dict):
    canvas_id = args.get("canvas_id")
    if not isinstance(canvas_id, int) or await get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    canvas = await get_owned_canvas(db, user_id, canvas_id)
    entries, batched, error = _mutation_entries(args, "notes")
    if error:
        return {"error": error}
    results = []
    try:
        for entry in entries:
            _reject_card_size(entry)
            title = entry.get("title") or "新便签"
            content = entry.get("content") or ""
            if not isinstance(title, str) or len(title.strip()) > 300 or not isinstance(content, str):
                raise ValueError("便签标题或正文格式不正确")
            color = validate_note_color(entry.get("color", "amber"))
            x, y = await _resolve_canvas_position(db, user_id, canvas, None, entry.get("position"))
            node, item = await create_canvas_note(
                db, user_id, canvas_id, title.strip() or "新便签", content, color, x, y, commit=False,
            )
            results.append({"canvas_id": canvas_id, "node": _node_summary(node, item), "created": True})
    except (TypeError, ValueError) as exc:
        return {"error": str(exc)}
    return {"canvas_id": canvas_id, "results": results, "count": len(results)} if batched else results[0]


async def _canvas_add_node(db, user_id, args: dict):
    canvas_id = args.get("canvas_id")
    if not isinstance(canvas_id, int):
        return {"error": "需要提供 canvas_id"}
    canvas = await get_owned_canvas(db, user_id, canvas_id)
    if canvas is None:
        return {"error": "画布不存在"}
    entries, batched, error = _mutation_entries(args, "nodes")
    if error:
        return {"error": error}
    results = []
    try:
        for entry in entries:
            _reject_card_size(entry)
            node_id = entry.get("node_id")
            if isinstance(node_id, int):
                node = await get_canvas_reference_node(db, user_id, node_id)
                if node is None:
                    raise ValueError("只能把项目、文件或活动引用节点放入画布")
            else:
                ref_type, ref_id = entry.get("ref_type"), entry.get("ref_id")
                if ref_type not in _PLACEABLE_TYPES or not isinstance(ref_id, int):
                    raise ValueError("需要提供 ref_type 和 ref_id，且类型必须是 project、file 或 event")
                node, _ = await get_or_create_reference(db, user_id, ref_type, ref_id)
            existing = await get_canvas_item_by_node(db, user_id, canvas_id, node.id)
            if existing is None:
                x, y = await _resolve_canvas_position(db, user_id, canvas, node, entry.get("position"))
                existing, created = await add_canvas_item(db, user_id, canvas_id, node, x, y, commit=False)
            else:
                created = False
            results.append({"canvas_id": canvas_id, "node": _node_summary(node, existing), "created": created})
    except (TypeError, ValueError, LookupError) as exc:
        return {"error": str(exc)}
    return {"canvas_id": canvas_id, "results": results, "count": len(results)} if batched else results[0]


async def _canvas_update_node(db, user_id, args: dict):
    canvas_id, item_id = args.get("canvas_id"), args.get("item_id")
    if not isinstance(canvas_id, int):
        return {"error": "需要提供 canvas_id"}
    if await get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    entries, batched, error = _mutation_entries(args, "updates")
    if error:
        return {"error": error}
    results = []
    try:
        for entry in entries:
            _reject_card_size(entry)
            item_id = entry.get("item_id")
            if not isinstance(item_id, int):
                raise ValueError("需要提供 item_id")
            if await get_canvas_item(db, user_id, canvas_id, item_id) is None:
                raise ValueError("画布节点不存在")
            fields = {}
            for key in ("x", "y"):
                if key in entry:
                    value = entry[key]
                    if not _finite_number(value):
                        raise ValueError(f"{key} 必须是有效数字")
                    fields[key] = float(value)
            if "z" in entry:
                if not isinstance(entry["z"], int):
                    raise ValueError("z 必须是整数")
                fields["z"] = entry["z"]
            if "collapsed" in entry:
                if not isinstance(entry["collapsed"], bool):
                    raise ValueError("collapsed 必须是布尔值")
                fields["collapsed"] = entry["collapsed"]
            if not fields:
                raise ValueError("至少提供一个要修改的布局字段")
            item = await update_canvas_item(db, user_id, canvas_id, item_id, fields, commit=False)
            node = await get_canvas_node(db, user_id, item.node_id)
            results.append({"canvas_id": canvas_id, "node": _node_summary(node, item), "updated": True})
    except (TypeError, ValueError) as exc:
        return {"error": str(exc)}
    return {"canvas_id": canvas_id, "results": results, "count": len(results)} if batched else results[0]


async def _canvas_remove_node(db, user_id, args: dict):
    canvas_id = args.get("canvas_id")
    if not isinstance(canvas_id, int):
        return {"error": "需要提供 canvas_id"}
    if await get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    raw_ids = args.get("item_ids")
    batched = raw_ids is not None
    item_ids = raw_ids if batched else [args.get("item_id")]
    if not isinstance(item_ids, list) or not item_ids:
        return {"error": "item_ids 必须是非空数组" if batched else "需要提供 item_id"}
    if len(item_ids) > _MAX_MUTATIONS or any(not isinstance(item_id, int) for item_id in item_ids):
        return {"error": f"单次最多处理 {_MAX_MUTATIONS} 个有效 item_id"}
    results = []
    try:
        for item_id in item_ids:
            item = await get_canvas_item(db, user_id, canvas_id, item_id)
            if item is None:
                raise ValueError("画布节点不存在")
            node_id = await remove_canvas_item(db, user_id, canvas_id, item_id, commit=False)
            results.append({"canvas_id": canvas_id, "removed_item_id": item_id, "node_id": node_id, "node_preserved": True})
    except (TypeError, ValueError) as exc:
        return {"error": str(exc)}
    return {"canvas_id": canvas_id, "results": results, "count": len(results)} if batched else results[0]


async def _canvas_update_note(db, user_id, args: dict):
    entries, batched, error = _mutation_entries(args, "updates")
    if error:
        return {"error": error}
    results = []
    try:
        for entry in entries:
            node_id = entry.get("node_id")
            if not isinstance(node_id, int):
                raise ValueError("更新画布便签必须提供 node_id")
            current = await get_canvas_note(db, user_id, node_id)
            if current is None:
                raise ValueError("找不到这条画布便签")
            fields = {}
            if "title" in entry:
                if not isinstance(entry["title"], str) or len(entry["title"].strip()) > 300:
                    raise ValueError("便签标题格式不正确")
                fields["title"] = entry["title"].strip() or "新便签"
            if "content" in entry:
                if not isinstance(entry["content"], str):
                    raise ValueError("便签正文必须是文本")
                fields["content_md"] = entry["content"]
            if "color" in entry:
                fields["color"] = validate_note_color(entry["color"])
            if not fields:
                raise ValueError("至少提供一个要修改的字段")
            node = await update_canvas_note(db, user_id, node_id, current.version, fields, commit=False)
            if node is False:
                raise ValueError("画布便签刚被修改，请稍后重试")
            results.append({"node": _node_summary(node), "updated": True})
    except (TypeError, ValueError) as exc:
        return {"error": str(exc)}
    return {"results": results, "count": len(results)} if batched else results[0]


async def _canvas_delete_note(db, user_id, args: dict):
    from agent.security import confirm
    entries, batched, error = _mutation_entries(args, "notes")
    if error:
        return {"error": error}
    checked = []
    for entry in entries:
        node_id = entry.get("node_id")
        if not isinstance(node_id, int):
            return {"error": "删除画布便签必须提供 node_id"}
        node = await get_canvas_note(db, user_id, node_id)
        if node is None:
            return {"error": "找不到这条画布便签"}
        checked.append((node_id, node.version, node))
    if batched:
        message = f"将删除 {len(checked)} 条画布便签，并从画布移除其视图项"
    else:
        message = f"将删除画布便签「{checked[0][2].title or '未命名'}」，并从画布移除其视图项"
    blocked = confirm.needs_confirmation(args, message, user_id)
    if blocked is not None:
        return blocked
    results = []
    try:
        for node_id, version, _ in checked:
            if not await delete_canvas_note(db, user_id, node_id, version, commit=False):
                raise ValueError("画布便签刚被修改，请稍后重试")
            results.append({"deleted_node_id": node_id, "can_restore": True})
    except (TypeError, ValueError) as exc:
        return {"error": str(exc)}
    return {"results": results, "count": len(results)} if batched else results[0]


async def _canvas_connect(db, user_id, args: dict):
    canvas_id, source_id, target_id = args.get("canvas_id"), args.get("source_node_id"), args.get("target_node_id")
    if not all(isinstance(value, int) for value in (canvas_id, source_id, target_id)):
        return {"error": "需要提供 canvas_id、source_node_id 和 target_node_id"}
    if await get_owned_canvas(db, user_id, canvas_id) is None:
        return {"error": "画布不存在"}
    if source_id == target_id:
        return {"error": "节点不能连向自己"}
    source_side, target_side = args.get("source_side"), args.get("target_side")
    allow_custom_anchor = args.get("allow_custom_anchor") is True
    if (source_side is None) != (target_side is None):
        return {"error": "source_side 和 target_side 必须同时提供"}
    if ((source_side is not None and source_side not in {"left", "right"})
            or (target_side is not None and target_side not in {"left", "right"})):
        return {"error": "连接点只能是 left 或 right"}
    canvas = await get_owned_canvas(db, user_id, canvas_id)
    geometry_sides = None
    source_item = await get_canvas_item_by_node(db, user_id, canvas_id, source_id)
    target_item = await get_canvas_item_by_node(db, user_id, canvas_id, target_id)
    source_node = await get_canvas_node(db, user_id, source_id, deleted=False)
    target_node = await get_canvas_node(db, user_id, target_id, deleted=False)
    if source_item is not None and target_item is not None and source_node is not None and target_node is not None:
        geometry_sides = _recommended_relation_sides(
            _node_summary(source_node, source_item),
            _node_summary(target_node, target_item),
        )
    if source_side is not None and geometry_sides is not None:
        explicit_sides = (source_side, target_side)
        if explicit_sides != geometry_sides and not allow_custom_anchor:
            return {
                "error": "普通连接的端点与卡片左右位置不一致，请省略 source_side/target_side；"
                "只有明确的回环或自定义布局才可传 allow_custom_anchor=true"
            }
    relation, error = await connect_nodes(
        db, user_id, canvas_id, source_id, target_id, args.get("type") or "related", commit=False,
    )
    if error:
        return {"error": error}
    anchor = relation_anchor_from_canvas(canvas, relation.id)
    before_anchor = anchor
    anchor_source = "existing" if anchor is not None else None
    if source_side is not None:
        # related 关系可能按节点 id 归一，端点必须跟返回的 source/target 字段保持一致。
        if source_id == relation.src_node_id:
            normalized = (source_side, target_side)
        else:
            normalized = (target_side, source_side)
        anchor = await update_relation_anchor(db, user_id, canvas_id, relation, *normalized, commit=False)
        anchor_source = "explicit"
    elif geometry_sides is not None:
        normalized = geometry_sides if source_id == relation.src_node_id else (geometry_sides[1], geometry_sides[0])
        anchor = await update_relation_anchor(db, user_id, canvas_id, relation, *normalized, commit=False)
        anchor_source = "geometry"
    return {
        "relation_id": relation.id,
        "source_node_id": relation.src_node_id,
        "target_node_id": relation.dst_node_id,
        "type": relation.rel_type,
        "created_or_reused": True,
        "changed": before_anchor != anchor,
        "anchor_source": anchor_source,
        "verification": {
            "checked_node_ids": [source_id, target_id],
            "checked_relation_id": relation.id,
            "geometry_recommendation": (
                {"source_side": geometry_sides[0], "target_side": geometry_sides[1]}
                if geometry_sides is not None else None
            ),
        },
        **(anchor or {}),
    }


async def _canvas_update_anchor(db, user_id, args: dict):
    canvas_id, relation_id = args.get("canvas_id"), args.get("relation_id")
    source_side, target_side = args.get("source_side"), args.get("target_side")
    if not isinstance(canvas_id, int) or not isinstance(relation_id, int):
        return {"error": "需要提供 canvas_id 和 relation_id"}
    if source_side not in {"left", "right"} or target_side not in {"left", "right"}:
        return {"error": "source_side 和 target_side 只能是 left 或 right"}
    relation = await get_canvas_relation(db, user_id, relation_id, canvas_id)
    if relation is None:
        return {"error": "关联不存在"}
    anchor = await update_relation_anchor(db, user_id, canvas_id, relation, source_side, target_side, commit=False)
    if anchor is None:
        return {"error": "关联的两个节点必须都位于指定画布"}
    return {"relation_id": relation.id, "source_node_id": relation.src_node_id, "target_node_id": relation.dst_node_id, **anchor, "updated": True}


async def _canvas_disconnect(db, user_id, args: dict):
    from agent.security import confirm
    canvas_id = args.get("canvas_id")
    if not isinstance(canvas_id, int):
        return {"error": "需要提供 canvas_id"}
    relation_ids = args.get("relation_ids")
    if relation_ids is not None:
        if not isinstance(relation_ids, list) or not relation_ids or len(relation_ids) > 50:
            return {"error": "relation_ids 必须是 1-50 个关联 id"}
        relations = []
        for relation_id in relation_ids:
            relation = await get_canvas_relation(db, user_id, relation_id, canvas_id)
            if relation is None:
                return {"error": f"关联 {relation_id} 不存在"}
            relations.append(relation)
        blocked = confirm.needs_confirmation(args, f"将删除 {len(relations)} 条节点关联", user_id,
                                             identity=f"canvas_disconnect:relation_ids={sorted(relation_ids)}")
        if blocked is not None:
            return blocked
        for relation in relations:
            await disconnect_node_relation(db, user_id, relation.id, canvas_id=canvas_id, commit=False)
        await db.commit()
        return {"success": True, "deleted_count": len(relations), "deleted_relation_ids": [r.id for r in relations]}
    relation_id = args.get("relation_id")
    if not isinstance(relation_id, int):
        return {"error": "需要提供 relation_id"}
    relation = await get_canvas_relation(db, user_id, relation_id, canvas_id)
    if relation is None:
        return {"error": "关联不存在"}
    blocked = confirm.needs_confirmation(args, f"将删除节点关联 {relation.src_node_id} ↔ {relation.dst_node_id}", user_id)
    if blocked is not None:
        return blocked
    await disconnect_node_relation(db, user_id, relation_id, canvas_id=canvas_id, commit=False)
    return {"deleted_relation_id": relation_id}


async def _canvas_batch(db, user_id, args: dict):
    """在一个事务内批量创建、放置、移除、调整布局和创建连接。

    引用节点/画布项/related 关系本身都有唯一约束，重试同一
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
    # 检查是否需要确认的操作（删除便签或删除画布）
    has_delete_note = any(isinstance(operation, dict) and operation.get("kind") == "delete_note" for operation in operations)
    # 注意：当前批量操作不支持删除画布本身，只支持删除画布内的便签/节点
    # 如果未来添加删除画布操作，需要在这里加上确认检查

    if has_delete_note:
        from agent.security import confirm
        blocked = confirm.needs_confirmation(
            args,
            f"将删除 {sum(isinstance(operation, dict) and operation.get('kind') == 'delete_note' for operation in operations)} 条画布便签，并从画布移除其视图项",
            user_id,
        )
        if blocked is not None:
            return blocked
    return await batch_canvas_operations(
        db, user_id, canvas, operations, request_id,
        resolve_position=_resolve_canvas_position,
        summarize=_node_summary,
    )
class MindCanvasSkill(BaseSkill):
    name = "mind_canvas"
    tools = [
        Tool(
            name="canvas_list", label="列出思维画布",
            description_short='列出可访问画布；未指定画布时先调用',
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
            handler=_canvas_list,
        ),
        Tool(
            name="canvas_get", label="读取思维画布",
            description_short='读取画布节点、连接和 viewport。',
            description=(
                "只读读取画布节点、连接和最后查看的 camera/viewport；排布或检查连线时必须参考节点实际尺寸、"
                "position 和 relation_audit。relation_audit 按两端卡片水平投影给出 recommended 端点；上下编排的卡片默认同侧出线，"
                "custom 只表示当前端点与默认建议不同，不代表可以直接修改；不要仅凭节点 ID 顺序判断左右。"
                "节点结果支持 limit/offset 分页；pagination.total/next_offset 表示是否还有节点。"
                "relations 返回全画布关系，relation_audit_scope=visible_nodes 表示当前页之外的关系端点会标记为 incomplete。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"},
                    "include_nodes": {"type": "boolean"},
                    "include_relations": {"type": "boolean"},
                    "include_content": {"type": "boolean"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                    "offset": {"type": "integer", "minimum": 0},
                },
                "required": ["canvas_id"],
            },
            handler=_canvas_get,
        ),
        Tool(
            name="canvas_search", label="搜索画布内容",
            description_short='固定工具名 canvas_search：搜索指定画布节点；传 canvas_id/query',
            description="搜索指定画布中已有的画布便签、项目、文件和活动引用。普通时间流 note 不属于画布，不会返回。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"},
                    "query": {"type": "string"},
                    "q": {"type": "string"},
                    "queries": {"type": "array", "items": {"type": "string"}},
                    "types": {"type": "array", "items": {"type": "string", "enum": list(_CANVAS_TYPES)}},
                    "mode": {"type": "string", "enum": ["OR", "AND"]},
                    "include_content": {"type": "boolean"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                },
                "required": ["canvas_id"],
            },
            handler=_canvas_search,
        ),
        Tool(
            name="canvas_search_placeable", label="搜索可放置画布节点",
            description_short='搜索可放入画布的项目/文件/活动；不含普通 note',
            description="搜索当前用户可访问、可以放入画布的项目、文件和日历活动。不会返回普通时间流 note，也不会因搜索自动创建引用节点。",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
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
            handler=_canvas_search_placeable,
        ),
        Tool(
            name="canvas_create", label="创建思维画布",
            description_short='创建思维画布。',
            description="按用户明确要求创建一张当前用户自己的思维画布；不能替用户猜测标题或项目。",
            input_schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "minLength": 1, "maxLength": 300},
                    "project_id": {"type": ["integer", "null"]},
                },
                "required": ["title"],
            },
            handler=_canvas_create,
            mutates=True,
        ),
        Tool(
            name="canvas_delete", label="删除思维画布",
            description_short='删除画布及内容；执行前需确认',
            description="删除一个或多个画布及其所有内容（便签、引用节点、连接关系全部清除）。单项传 canvas_id，批量传 canvas_ids；批量目标一次确认。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"},
                    "canvas_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 20},
                    "confirm": {"type": "boolean"},
                    "confirm_token": {"type": "string"},
                },
                "required": [],
                "oneOf": [
                    {"required": ["canvas_id"], "not": {"required": ["canvas_ids"]}},
                    {"required": ["canvas_ids"], "not": {"required": ["canvas_id"]}},
                ],
            },
            handler=_canvas_delete,
            mutates=True,
            destructive=True,
        ),
        Tool(
            name="canvas_create_note", label="创建画布便签",
            description_short='创建画布专属便签；不进入时间流 note',
            description="在指定画布创建专属便签，不进入时间流 note；卡片大小由系统管理。单项传 title/content，批量传 notes。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"},
                    "title": {"type": "string", "maxLength": 300},
                    "content": {"type": "string"},
                    "color": {"type": "string", "enum": ["amber", "coral", "blue", "teal"]},
                    "position": {"type": "object"},
                    "notes": {"type": "array", "minItems": 1, "maxItems": 20, "items": _CANVAS_NOTE_CREATE_ITEM_SCHEMA},
                },
                "required": ["canvas_id"],
                "oneOf": [
                    {"required": ["notes"], "not": {"anyOf": [{"required": ["title"]}, {"required": ["content"]}, {"required": ["color"]}, {"required": ["position"]}]}},
                    {"not": {"required": ["notes"]}},
                ],
            },
            handler=_canvas_create_note,
            mutates=True,
        ),
        Tool(
            name="canvas_add_node", label="放置画布节点",
            description_short='把项目/文件/活动放入画布；位置自动避让',
            description="把项目、文件或活动引用放入画布，最多 20 个；位置按节点实际尺寸避让。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"},
                    "node_id": {"type": "integer"},
                    "ref_type": {"type": "string", "enum": list(_PLACEABLE_TYPES)},
                    "ref_id": {"type": "integer"},
                    "position": {"type": "object"},
                    "nodes": {"type": "array", "minItems": 1, "maxItems": 20, "items": _CANVAS_ADD_NODE_ITEM_SCHEMA},
                },
                "required": ["canvas_id"],
                "oneOf": [
                    {"required": ["nodes"], "not": {"anyOf": [{"required": ["node_id"]}, {"required": ["ref_type"]}, {"required": ["ref_id"]}, {"required": ["position"]}]}},
                    {"required": ["node_id"], "not": {"required": ["nodes"]}},
                    {"required": ["ref_type", "ref_id"], "not": {"required": ["nodes"]}},
                ],
            },
            handler=_canvas_add_node,
            mutates=True,
        ),
        Tool(
            name="canvas_update_node", label="调整画布节点",
            description_short='调整画布节点位置和层级。',
            description="调整画布节点的位置、层级或折叠状态，不改变原项目、文件或活动。单项必须传 canvas_id、item_id 和至少一个布局字段；批量必须传 canvas_id 和 updates，每项必须传 item_id 和至少一个布局字段；所有 ID 为整数，x/y 为数字，z 为整数；不支持修改 w/h。",
            input_schema=_CANVAS_UPDATE_NODE_SCHEMA,
            handler=_canvas_update_node,
            mutates=True,
        ),
        Tool(
            name="canvas_remove_node", label="移除画布节点",
            description_short='移除画布节点视图。',
            description="从指定画布移除一个或多个节点视图，最多 20 个；不会删除项目、文件、活动或画布便签正文。单项调用使用 item_id，批量调用使用 item_ids 数组。",
            input_schema={
                "type": "object",
                "properties": {"canvas_id": {"type": "integer"}, "item_id": {"type": "integer"}, "item_ids": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "integer"}}},
                "required": ["canvas_id"],
                "oneOf": [
                    {"required": ["item_id"], "not": {"required": ["item_ids"]}},
                    {"required": ["item_ids"], "not": {"required": ["item_id"]}},
                ],
            },
            handler=_canvas_remove_node,
            mutates=True,
        ),
        Tool(
            name="canvas_update_note", label="修改画布便签",
            description_short='修改画布便签。',
            description="对一个或多个画布专属便签做字段增量更新，最多 20 个；不能修改普通时间流 note。单项使用 node_id，批量使用 updates。",
            input_schema={
                "type": "object",
                "properties": {
                    "node_id": {"type": "integer"},
                    "title": {"type": "string", "maxLength": 300}, "content": {"type": "string"},
                    "color": {"type": "string", "enum": ["amber", "coral", "blue", "teal"]},
                    "updates": {"type": "array", "minItems": 1, "maxItems": 20, "items": _CANVAS_NOTE_UPDATE_ITEM_SCHEMA},
                },
                "required": [],
                "oneOf": [
                    {"required": ["updates"], "not": {"anyOf": [{"required": ["node_id"]}, {"required": ["title"]}, {"required": ["content"]}, {"required": ["color"]}]}},
                    {"required": ["node_id"], "not": {"required": ["updates"]}, "anyOf": [{"required": ["title"]}, {"required": ["content"]}, {"required": ["color"]}]},
                ],
            },
            handler=_canvas_update_note,
            mutates=True,
        ),
        Tool(
            name="canvas_delete_note", label="删除画布便签",
            description_short='删除画布便签；执行前需确认',
            description="删除一个或多个画布专属便签并移除其画布视图，最多 20 个；执行前必须一次性展示影响并获得确认。单项使用 node_id，批量使用 notes。",
            input_schema={
                "type": "object",
                "properties": {"node_id": {"type": "integer"}, "notes": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object"}}, "confirm": {"type": "boolean"}, "confirm_token": {"type": "string"}},
                "required": [],
                "oneOf": [
                    {"required": ["node_id"], "not": {"required": ["notes"]}},
                    {"required": ["notes"], "not": {"required": ["node_id"]}},
                ],
            },
            handler=_canvas_delete_note,
            mutates=True,
            destructive=True,
        ),
        Tool(
            name="canvas_connect", label="连接画布节点",
            description_short='连接同画布节点；按卡片位置选择连接点',
            description=(
                "连接同一画布中的节点；默认 related 且幂等。普通连接不要传 source_side/target_side，"
                "由服务端按两端卡片中心的实际水平位置自动计算并保存，避免模型按节点 ID 或旧快照误判。"
                "只有用户明确要求回环、同侧端点或修正指定端点时才传这两个字段，并同时传 allow_custom_anchor=true；"
                "同一个卡片的同一 left/right 端口允许连接多个不同节点；不要为了避免多线而擅自换到另一侧。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"}, "source_node_id": {"type": "integer"},
                    "target_node_id": {"type": "integer"}, "type": {"type": "string", "enum": ["related"]},
                    "source_side": {"type": "string", "enum": ["left", "right"]},
                    "target_side": {"type": "string", "enum": ["left", "right"]},
                    "allow_custom_anchor": {"type": "boolean"},
                },
                "required": ["canvas_id", "source_node_id", "target_node_id"],
            },
            handler=_canvas_connect,
            mutates=True,
        ),
        Tool(
            name="canvas_update_anchor", label="调整画布连接点",
            description_short='修改连接两端。',
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
            handler=_canvas_update_anchor,
            mutates=True,
        ),
        Tool(
            name="canvas_disconnect", label="断开画布连接",
            description_short='断开画布连接。',
            description="删除一条或多条画布节点关联；单项传 relation_id，批量传 relation_ids；批量目标一次确认。",
            input_schema={
                "type": "object",
                "properties": {"canvas_id": {"type": "integer"}, "relation_id": {"type": "integer"}, "relation_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 50}, "confirm": {"type": "boolean"}, "confirm_token": {"type": "string"}},
                "required": ["canvas_id"],
                "oneOf": [
                    {"required": ["relation_id"], "not": {"required": ["relation_ids"]}},
                    {"required": ["relation_ids"], "not": {"required": ["relation_id"]}},
                ],
            },
            handler=_canvas_disconnect,
            mutates=True,
            destructive=True,
        ),
        Tool(
            name="canvas_batch", label="批量编排画布",
            description_short='批量编排画布节点/便签/连接；失败整批回滚',
            description="在一个事务内批量编排画布节点、便签和连接，最多 20 个操作；失败整批回滚。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"}, "request_id": {"type": "string", "maxLength": 120},
                    "operations": {"type": "array", "minItems": 1, "maxItems": 20, "items": {
                        "type": "object",
                        "properties": {
                            "kind": {"type": "string", "enum": ["create_note", "add_node", "update_item", "remove_item", "delete_note", "connect"]},
                            "ref_type": {"type": "string", "enum": list(_PLACEABLE_TYPES)}, "ref_id": {"type": "integer"},
                            "node_id": {"type": "integer"},
                            "item_id": {"type": "integer"}, "source_node_id": {"type": "integer"}, "target_node_id": {"type": "integer"},
                            "source_side": {"type": "string", "enum": ["left", "right"]}, "target_side": {"type": "string", "enum": ["left", "right"]},
                            "title": {"type": "string", "maxLength": 300}, "content": {"type": "string"},
                            "color": {"type": "string", "enum": ["amber", "coral", "blue", "teal"]},
                            "x": {"type": "number"}, "y": {"type": "number"},
                            "z": {"type": "integer"}, "collapsed": {"type": "boolean"}, "position": {"type": "object"},
                        },
                        "required": ["kind"],
                    }},
                },
                "required": ["canvas_id", "request_id", "operations"],
            },
            handler=_canvas_batch,
            mutates=True,
        ),
    ]


MindCanvasSkill().register()
