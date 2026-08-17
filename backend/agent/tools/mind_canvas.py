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
    remove_canvas_item,
    update_canvas_item,
    update_canvas_note,
    update_relation_anchor,
)
from app.services.mind_canvas_batch import batch_canvas_operations
from app.search.query import normalize_queries
from agent.tools.base import BaseSkill, Tool

_MAX_RESULTS = 20
_MAX_MUTATIONS = 20
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
        # 画布便签更新走 MindNode 乐观锁；搜索结果必须携带当前版本，禁止调用方猜版本重试。
        "version": node.version,
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
    rows = await list_canvas_nodes(db, user_id, canvas.id, limit=limit + 1)
    visible_rows = rows[:limit]
    result["nodes"] = [_node_summary(node, item, include_content=include_content) for item, node in visible_rows]
    result["truncated"] = len(rows) > limit
    if include_relations:
        node_ids = [node.id for _, node in visible_rows]
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
        # 空画布：camera 是屏幕偏移量，world = -camera/scale + margin
        world_x = -camera_x / scale + 40
        world_y = -camera_y / scale + 40
        return world_x, world_y
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
    canvas = await create_canvas(db, user_id, title, project_id, commit=False)
    if canvas is None:
        return {"error": "项目不存在"}
    return {"canvas": {"canvas_id": canvas.id, "title": canvas.title, "project_id": canvas.project_id}}


async def _mind_create_canvas_note(db, user_id, args: dict):
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


async def _mind_add_canvas_node(db, user_id, args: dict):
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


async def _mind_update_canvas_node(db, user_id, args: dict):
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


async def _mind_remove_canvas_node(db, user_id, args: dict):
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


async def _mind_update_canvas_note(db, user_id, args: dict):
    entries, batched, error = _mutation_entries(args, "updates")
    if error:
        return {"error": error}
    results = []
    try:
        for entry in entries:
            node_id, version = entry.get("node_id"), entry.get("version")
            if not isinstance(node_id, int) or not isinstance(version, int):
                raise ValueError("更新画布便签必须提供 node_id 和 version")
            if await get_canvas_note(db, user_id, node_id) is None:
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
            node = await update_canvas_note(db, user_id, node_id, version, fields, commit=False)
            if node is False:
                raise ValueError("画布便签已被其他端修改，请先重新读取后再更新")
            results.append({"node": _node_summary(node), "updated": True})
    except (TypeError, ValueError) as exc:
        return {"error": str(exc)}
    return {"results": results, "count": len(results)} if batched else results[0]


async def _mind_delete_canvas_note(db, user_id, args: dict):
    from agent.security import confirm
    entries, batched, error = _mutation_entries(args, "notes")
    if error:
        return {"error": error}
    checked = []
    for entry in entries:
        node_id, version = entry.get("node_id"), entry.get("version")
        if not isinstance(node_id, int) or not isinstance(version, int):
            return {"error": "删除画布便签必须提供 node_id 和 version"}
        node = await get_canvas_note(db, user_id, node_id)
        if node is None:
            return {"error": "找不到这条画布便签"}
        if node.version != version:
            return {"error": "画布便签已被其他端修改，请先重新读取后再删除"}
        checked.append((node_id, version, node))
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
                raise ValueError("画布便签已被其他端修改，请先重新读取后再删除")
            results.append({"deleted_node_id": node_id, "can_restore": True})
    except (TypeError, ValueError) as exc:
        return {"error": str(exc)}
    return {"results": results, "count": len(results)} if batched else results[0]


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
        db, user_id, canvas_id, source_id, target_id, args.get("type") or "related", commit=False,
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
        anchor = await update_relation_anchor(db, user_id, canvas_id, relation, *normalized, commit=False)
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
    anchor = await update_relation_anchor(db, user_id, canvas_id, relation, source_side, target_side, commit=False)
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
    await disconnect_node_relation(db, user_id, relation_id, commit=False)
    return {"deleted_relation_id": relation_id}


async def _mind_batch_canvas(db, user_id, args: dict):
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
    if any(isinstance(operation, dict) and operation.get("kind") == "delete_note" for operation in operations):
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
            description="在指定画布创建一个或多个专属便签，最多 20 个。它们不会进入时间流 note；普通时间流笔记不能通过此工具放入画布。卡片大小由系统管理，不能传 w/h。单项调用使用 title/content，批量调用使用 notes 数组。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"},
                    "title": {"type": "string", "maxLength": 300, "description": "可选；仅用于搜索与列表索引，画布卡片上用户不可见。用户可见的标题必须写在 content 第一行，格式 # 标题"},
                    "content": {"type": "string"},
                    "color": {"type": "string", "enum": ["amber", "coral", "blue", "teal"]},
                    "position": {"type": "object"},
                    "notes": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object"}},
                },
                "required": ["canvas_id"],
            },
            handler=_mind_create_canvas_note,
            mutates=True,
        ),
        Tool(
            name="mind_add_canvas_node", label="放置画布节点",
            description="把当前用户的项目、文件或日历活动引用放入画布，单次最多 20 个。卡片大小由系统管理，不能传 w/h。单项调用使用 node_id 或 ref_type/ref_id，批量调用使用 nodes 数组。position.x/y 是卡片左上角；放置前必须按已有节点的 layout.effective_size 避让。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"},
                    "node_id": {"type": "integer"},
                    "ref_type": {"type": "string", "enum": list(_PLACEABLE_TYPES)},
                    "ref_id": {"type": "integer"},
                    "position": {"type": "object"},
                    "nodes": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object"}},
                },
                "required": ["canvas_id"],
            },
            handler=_mind_add_canvas_node,
            mutates=True,
        ),
        Tool(
            name="mind_update_canvas_node", label="调整画布节点",
            description="调整一个或多个已放置节点的位置、层级或折叠状态，最多 20 个；卡片大小由系统按节点类型统一管理，工具不支持修改 w/h。只改变画布视图，不改变原项目、文件或活动。单项调用使用 item_id，批量调用使用 updates 数组。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"}, "item_id": {"type": "integer"},
                    "x": {"type": "number"}, "y": {"type": "number"},
                    "z": {"type": "integer"}, "collapsed": {"type": "boolean"},
                    "updates": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object"}},
                },
                "required": ["canvas_id"],
            },
            handler=_mind_update_canvas_node,
            mutates=True,
        ),
        Tool(
            name="mind_remove_canvas_node", label="移除画布节点",
            description="从指定画布移除一个或多个节点视图，最多 20 个；不会删除项目、文件、活动或画布便签正文。单项调用使用 item_id，批量调用使用 item_ids 数组。",
            input_schema={
                "type": "object",
                "properties": {"canvas_id": {"type": "integer"}, "item_id": {"type": "integer"}, "item_ids": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "integer"}}},
                "required": ["canvas_id"],
            },
            handler=_mind_remove_canvas_node,
            mutates=True,
        ),
        Tool(
            name="mind_update_canvas_note", label="修改画布便签",
            description="按 node_id 和 version 修改一个或多个画布专属便签，最多 20 个；不能修改普通时间流 note。单项调用使用 node_id/version，批量调用使用 updates 数组。",
            input_schema={
                "type": "object",
                "properties": {
                    "node_id": {"type": "integer"}, "version": {"type": "integer"},
                    "title": {"type": "string", "maxLength": 300, "description": "可选；仅用于搜索与列表索引，画布卡片上用户不可见。用户可见的标题必须写在 content 第一行，格式 # 标题"}, "content": {"type": "string"},
                    "color": {"type": "string", "enum": ["amber", "coral", "blue", "teal"]},
                    "updates": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object"}},
                },
                "required": [],
            },
            handler=_mind_update_canvas_note,
            mutates=True,
        ),
        Tool(
            name="mind_delete_canvas_note", label="删除画布便签",
            description="删除一个或多个画布专属便签并移除其画布视图，最多 20 个；执行前必须一次性展示影响并获得确认。单项调用使用 node_id/version，批量调用使用 notes 数组。",
            input_schema={
                "type": "object",
                "properties": {"node_id": {"type": "integer"}, "version": {"type": "integer"}, "notes": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object"}}, "confirm": {"type": "boolean"}, "confirm_token": {"type": "string"}},
                "required": [],
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
            description="在一个事务内最多 20 个操作：创建便签、放置项目/文件/活动引用、调整位置/层级/折叠状态、移除视图、删除便签和创建 related 连接。卡片大小由系统管理，不能传 w/h。失败会整批回滚，删除便签会先统一确认；使用 request_id 重试可复用已有对象。",
            input_schema={
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "integer"}, "request_id": {"type": "string", "maxLength": 120},
                    "operations": {"type": "array", "minItems": 1, "maxItems": 20, "items": {
                        "type": "object",
                        "properties": {
                            "kind": {"type": "string", "enum": ["create_note", "add_node", "update_item", "remove_item", "delete_note", "connect"]},
                            "ref_type": {"type": "string", "enum": list(_PLACEABLE_TYPES)}, "ref_id": {"type": "integer"},
                            "node_id": {"type": "integer"}, "version": {"type": "integer"},
                            "item_id": {"type": "integer"}, "source_node_id": {"type": "integer"}, "target_node_id": {"type": "integer"},
                            "source_side": {"type": "string", "enum": ["left", "right"]}, "target_side": {"type": "string", "enum": ["left", "right"]},
                            "title": {"type": "string", "maxLength": 300, "description": "可选；仅用于搜索与列表索引，画布卡片上用户不可见。用户可见的标题必须写在 content 第一行，格式 # 标题"}, "content": {"type": "string"},
                            "color": {"type": "string", "enum": ["amber", "coral", "blue", "teal"]},
                            "x": {"type": "number"}, "y": {"type": "number"},
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
