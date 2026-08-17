"""Mind Canvas Agent 批处理事务与 request_id 幂等边界。"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.mind_canvas_batch import MindCanvasBatchRequest
from app.services.mind_canvas import (
    add_canvas_item,
    connect_nodes,
    create_canvas_note,
    delete_canvas_note,
    get_canvas_item,
    get_canvas_item_by_node,
    get_canvas_node,
    get_or_create_reference,
    remove_canvas_item,
    update_canvas_item,
    update_relation_anchor,
)

_RELATION_SIDES = frozenset(("left", "right"))
_PLACEABLE_TYPES = frozenset(("project", "file", "event"))


def _payload_fingerprint(operations: list[Any]) -> str:
    payload = json.dumps(
        operations,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


async def _find_request(db, user_id, canvas_id: int, request_id: str):
    return await db.scalar(select(MindCanvasBatchRequest).where(
        MindCanvasBatchRequest.user_id == user_id,
        MindCanvasBatchRequest.canvas_id == canvas_id,
        MindCanvasBatchRequest.request_id == request_id,
    ))


def _replay_request(record: MindCanvasBatchRequest, fingerprint: str, request_id: str) -> dict[str, Any]:
    if record.payload_hash != fingerprint:
        return {
            "error": "request_id 已用于不同的批量请求，请更换 request_id",
            "request_id": request_id,
            "idempotency_conflict": True,
        }
    try:
        result = json.loads(record.result_json)
    except (TypeError, json.JSONDecodeError):
        return {
            "error": "request_id 的历史结果损坏，无法安全重放",
            "request_id": request_id,
        }
    return result if isinstance(result, dict) else {
        "error": "request_id 的历史结果格式不正确，无法安全重放",
        "request_id": request_id,
    }


def _finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


async def batch_canvas_operations(
    db,
    user_id,
    canvas,
    operations,
    request_id,
    *,
    resolve_position,
    summarize,
):
    """原子执行批处理，并把首次成功结果与 payload 指纹一起持久化。

    `(user_id, canvas_id, request_id)` 是唯一幂等键：相同 payload 直接返回首次
    成功结果；不同 payload 明确冲突。失败事务不留下记录，因此可以修正请求后重试。
    """
    fingerprint = _payload_fingerprint(operations)
    existing = await _find_request(db, user_id, canvas.id, request_id)
    if existing is not None:
        return _replay_request(existing, fingerprint, request_id)

    record = MindCanvasBatchRequest(
        user_id=user_id,
        canvas_id=canvas.id,
        request_id=request_id,
        payload_hash=fingerprint,
        result_json="",
    )
    db.add(record)
    try:
        # 先占用唯一键。并发的相同 request_id 会在这里串行化，而不是各自执行副作用。
        await db.flush()
    except IntegrityError:
        await db.rollback()
        existing = await _find_request(db, user_id, canvas.id, request_id)
        if existing is not None:
            return _replay_request(existing, fingerprint, request_id)
        return {
            "error": "request_id 并发去重失败，请重试",
            "request_id": request_id,
            "rolled_back": True,
        }

    results: list[dict[str, Any]] = []
    try:
        for index, operation in enumerate(operations):
            if not isinstance(operation, dict):
                raise ValueError(f"第 {index + 1} 个操作格式不正确")
            if any(key in operation for key in ("w", "h")):
                raise ValueError(f"第 {index + 1} 个操作不能修改画布卡片大小")
            position = operation.get("position")
            if isinstance(position, dict) and any(key in position for key in ("w", "h")):
                raise ValueError(f"第 {index + 1} 个操作不能在 position 中传入卡片大小")

            kind = operation.get("kind")
            if kind == "create_note":
                title = operation.get("title") or "新便签"
                content = operation.get("content") or ""
                if not isinstance(title, str) or len(title.strip()) > 300 or not isinstance(content, str):
                    raise ValueError(f"第 {index + 1} 个便签操作格式不正确")
                x, y = await resolve_position(db, user_id, canvas, None, operation.get("position"))
                node, item = await create_canvas_note(
                    db,
                    user_id,
                    canvas.id,
                    title.strip() or "新便签",
                    content,
                    operation.get("color", "amber"),
                    x,
                    y,
                    commit=False,
                )
                results.append({
                    "index": index,
                    "kind": kind,
                    "created": True,
                    "node": summarize(node, item),
                })
                continue

            if kind == "add_node":
                ref_type, ref_id = operation.get("ref_type"), operation.get("ref_id")
                if ref_type not in _PLACEABLE_TYPES or not isinstance(ref_id, int):
                    raise ValueError(f"第 {index + 1} 个放置操作缺少有效引用")
                node, _ = await get_or_create_reference(db, user_id, ref_type, ref_id)
                item = await get_canvas_item_by_node(db, user_id, canvas.id, node.id)
                created = item is None
                if item is None:
                    x, y = await resolve_position(db, user_id, canvas, node, operation.get("position"))
                    item, created = await add_canvas_item(
                        db, user_id, canvas.id, node, x, y, commit=False,
                    )
                results.append({
                    "index": index,
                    "kind": kind,
                    "created": created,
                    "node": summarize(node, item),
                })
                continue

            if kind == "update_item":
                item_id = operation.get("item_id")
                if not isinstance(item_id, int):
                    raise ValueError(f"第 {index + 1} 个布局操作缺少 item_id")
                item = await get_canvas_item(db, user_id, canvas.id, item_id)
                if item is None:
                    raise ValueError(f"第 {index + 1} 个布局操作找不到节点")
                fields: dict[str, Any] = {}
                for key in ("x", "y"):
                    if key in operation:
                        if not _finite_number(operation[key]):
                            raise ValueError(f"第 {index + 1} 个布局操作包含无效 {key}")
                        fields[key] = float(operation[key])
                if "z" in operation:
                    if not isinstance(operation["z"], int) or isinstance(operation["z"], bool):
                        raise ValueError(f"第 {index + 1} 个布局操作包含无效 z")
                    fields["z"] = operation["z"]
                if "collapsed" in operation:
                    if not isinstance(operation["collapsed"], bool):
                        raise ValueError(f"第 {index + 1} 个布局操作包含无效 collapsed")
                    fields["collapsed"] = operation["collapsed"]
                if not fields:
                    raise ValueError(f"第 {index + 1} 个布局操作没有修改字段")
                item = await update_canvas_item(
                    db, user_id, canvas.id, item_id, fields, commit=False,
                )
                node = await get_canvas_node(db, user_id, item.node_id)
                results.append({
                    "index": index,
                    "kind": kind,
                    "updated": True,
                    "node": summarize(node, item),
                })
                continue

            if kind == "remove_item":
                item_id = operation.get("item_id")
                if not isinstance(item_id, int):
                    raise ValueError(f"第 {index + 1} 个移除操作缺少 item_id")
                item = await get_canvas_item(db, user_id, canvas.id, item_id)
                if item is None:
                    raise ValueError(f"第 {index + 1} 个移除操作找不到节点")
                node_id = await remove_canvas_item(
                    db, user_id, canvas.id, item_id, commit=False,
                )
                results.append({
                    "index": index,
                    "kind": kind,
                    "removed_item_id": item_id,
                    "node_id": node_id,
                    "node_preserved": True,
                })
                continue

            if kind == "delete_note":
                node_id, version = operation.get("node_id"), operation.get("version")
                if not isinstance(node_id, int) or not isinstance(version, int):
                    raise ValueError(f"第 {index + 1} 个删除便签操作缺少 node_id 或 version")
                node = await get_canvas_node(
                    db, user_id, node_id, kind="canvas_note", deleted=False,
                )
                if node is None or node.version != version:
                    raise ValueError(f"第 {index + 1} 个画布便签已被其他端修改，请先重新读取")
                if not await delete_canvas_note(
                    db, user_id, node_id, version, commit=False,
                ):
                    raise ValueError(f"第 {index + 1} 个画布便签删除失败")
                results.append({
                    "index": index,
                    "kind": kind,
                    "deleted_node_id": node_id,
                    "can_restore": True,
                })
                continue

            if kind == "connect":
                source_id, target_id = operation.get("source_node_id"), operation.get("target_node_id")
                if not isinstance(source_id, int) or not isinstance(target_id, int):
                    raise ValueError(f"第 {index + 1} 个连接操作缺少节点")
                source_side, target_side = operation.get("source_side"), operation.get("target_side")
                if (source_side is None) != (target_side is None):
                    raise ValueError(f"第 {index + 1} 个连接操作的两端连接点必须同时提供")
                if ((source_side is not None and source_side not in _RELATION_SIDES)
                        or (target_side is not None and target_side not in _RELATION_SIDES)):
                    raise ValueError(f"第 {index + 1} 个连接操作的连接点只能是 left 或 right")
                relation, error = await connect_nodes(
                    db, user_id, canvas.id, source_id, target_id, commit=False,
                )
                if error:
                    raise ValueError(f"第 {index + 1} 个连接操作{error}")
                if source_side is not None:
                    sides = (
                        (source_side, target_side)
                        if source_id == relation.src_node_id
                        else (target_side, source_side)
                    )
                    if await update_relation_anchor(
                        db, user_id, canvas.id, relation, *sides, commit=False,
                    ) is None:
                        raise ValueError(f"第 {index + 1} 个连接操作找不到关系所在画布")
                results.append({
                    "index": index,
                    "kind": kind,
                    "relation_id": relation.id,
                    "created_or_reused": True,
                })
                continue

            raise ValueError(f"不支持的批量操作 {kind or '空操作'}")

        response = {
            "canvas_id": canvas.id,
            "request_id": request_id,
            "operations": results,
            "atomic": True,
        }
        record.result_json = json.dumps(
            response,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        await db.commit()
        return response
    except Exception as exc:
        await db.rollback()
        return {
            "error": str(exc),
            "request_id": request_id,
            "rolled_back": True,
        }
