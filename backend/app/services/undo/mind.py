"""思维画布的可撤销快照和逆操作。

画布、画布项和关系使用软删除保留原主键；全局便签节点复用已有 version/deleted_at。
这样删除画布或画布项不会因为重建主键而断开关系，也不会影响引用节点在其它画布上的展示。
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime

from sqlalchemy import select

from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import MindCanvasItem, MindMap, MindNode, MindRelation, UndoOperation
from app.services.undo.service import UndoConflict, UndoError


def _iso(value):
    return value.isoformat() if value else None


def _dt(value):
    return datetime.fromisoformat(value) if value else None


def canvas_snapshot(row: MindMap) -> dict:
    return {"id": row.id, "title": row.title, "project_id": row.project_id,
            "data_json": row.data_json, "deleted_at": _iso(row.deleted_at)}


def node_snapshot(row: MindNode) -> dict:
    return {"id": row.id, "kind": row.kind, "title": row.title, "content_md": row.content_md,
            "content_plain": row.content_plain, "color": row.color, "ref_type": row.ref_type,
            "ref_id": row.ref_id, "ref_snapshot": deepcopy(row.ref_snapshot),
            "origin": row.origin, "captured_at": _iso(row.captured_at), "version": int(row.version or 1),
            "deleted_at": _iso(row.deleted_at)}


def item_snapshot(row: MindCanvasItem) -> dict:
    return {"id": row.id, "canvas_id": row.canvas_id, "node_id": row.node_id, "x": row.x, "y": row.y,
            "w": row.w, "h": row.h, "z": row.z, "collapsed": row.collapsed,
            "data_json": row.data_json, "deleted_at": _iso(row.deleted_at)}


def relation_snapshot(row: MindRelation) -> dict:
    return {"id": row.id, "canvas_id": row.canvas_id, "src_node_id": row.src_node_id,
            "dst_node_id": row.dst_node_id, "rel_type": row.rel_type, "edge_key": row.edge_key,
            "origin": row.origin, "status": row.status, "note": row.note, "deleted_at": _iso(row.deleted_at)}


def state(items: dict[str, dict]) -> dict:
    return {"items": deepcopy(items)}


def ref(kind: str, row_id: int) -> str:
    return f"{kind}:{row_id}"


class MindUndoAdapter:
    def __init__(self, db):
        self.db = db

    async def _load(self, user_id, key: str):
        kind, raw_id = key.split(":", 1)
        model = {"canvas": MindMap, "canvas_item": MindCanvasItem,
                 "canvas_note": MindNode, "note": MindNode, "ref_node": MindNode,
                 "relation": MindRelation}.get(kind)
        if model is None:
            raise UndoError("undo.unsupported", "撤销记录包含未知画布资源")
        row = await get_owned(self.db, model, int(raw_id), user_id)
        if row is None:
            raise UndoConflict("画布资源已不存在，无法安全撤回")
        return kind, row

    @staticmethod
    def _same(row, snapshot: dict) -> bool:
        kind = snapshot.get("kind")
        if isinstance(row, MindNode):
            return (row.kind, row.title, row.content_md, row.content_plain, row.color,
                    _iso(row.captured_at), _iso(row.deleted_at)) == tuple(snapshot.get(k) for k in (
                        "kind", "title", "content_md", "content_plain", "color", "captured_at", "deleted_at"))
        if hasattr(row, "version") and "version" in snapshot:
            return int(row.version or 1) == int(snapshot["version"])
        if isinstance(row, MindMap):
            return (row.title, row.project_id, row.data_json, _iso(row.deleted_at)) == (
                snapshot.get("title"), snapshot.get("project_id"), snapshot.get("data_json"), snapshot.get("deleted_at"))
        if isinstance(row, MindCanvasItem):
            return (row.canvas_id, row.node_id, row.x, row.y, row.w, row.h, row.z, row.collapsed,
                    row.data_json, _iso(row.deleted_at)) == tuple(snapshot.get(k) for k in (
                        "canvas_id", "node_id", "x", "y", "w", "h", "z", "collapsed", "data_json", "deleted_at"))
        if isinstance(row, MindRelation):
            return (row.canvas_id, row.src_node_id, row.dst_node_id, row.rel_type, row.edge_key,
                    row.origin, row.status, row.note, _iso(row.deleted_at)) == tuple(snapshot.get(k) for k in (
                        "canvas_id", "src_node_id", "dst_node_id", "rel_type", "edge_key", "origin", "status", "note", "deleted_at"))
        return kind is not None

    async def _preflight(self, operation: UndoOperation, user_id, *, redo: bool):
        items = (operation.after_state if not redo else operation.after_state).get("items", {})
        expected_versions = operation.after_state.get("undo_versions", {}) if redo else {}
        for key, snapshot in items.items():
            _, row = await self._load(user_id, key)
            if redo:
                if hasattr(row, "version"):
                    if int(row.version or 1) != int(expected_versions.get(key, -1)):
                        raise UndoConflict()
                elif not self._same(row, expected_versions.get(key, {})):
                    raise UndoConflict()
            elif not self._same(row, snapshot):
                raise UndoConflict()

    @staticmethod
    def _apply(row, snapshot: dict):
        if isinstance(row, MindMap):
            for field in ("title", "project_id", "data_json"):
                if field in snapshot:
                    setattr(row, field, snapshot[field])
            row.deleted_at = _dt(snapshot.get("deleted_at"))
        elif isinstance(row, MindCanvasItem):
            for field in ("x", "y", "w", "h", "z", "collapsed", "data_json"):
                if field in snapshot:
                    setattr(row, field, snapshot[field])
            row.deleted_at = _dt(snapshot.get("deleted_at"))
        elif isinstance(row, MindRelation):
            for field in ("rel_type", "edge_key", "origin", "status", "note"):
                if field in snapshot:
                    setattr(row, field, snapshot[field])
            row.deleted_at = _dt(snapshot.get("deleted_at"))
        elif isinstance(row, MindNode):
            for field in ("title", "content_md", "content_plain", "color", "captured_at", "ref_snapshot"):
                if field in snapshot:
                    setattr(row, field, _dt(snapshot[field]) if field == "captured_at" else snapshot[field])
            row.deleted_at = _dt(snapshot.get("deleted_at"))
            row.version = int(row.version or 1) + 1
        row.updated_at = now_utc()

    async def undo(self, operation: UndoOperation, user_id):
        after = operation.after_state.get("items", {})
        before = operation.before_state.get("items", {})
        await self._preflight(operation, user_id, redo=False)
        versions = {}
        for key, snapshot in after.items():
            kind, row = await self._load(user_id, key)
            if operation.action == "create":
                target = {**snapshot, "deleted_at": _iso(now_utc())}
            elif operation.action == "delete":
                target = before.get(key, {**snapshot, "deleted_at": None})
            else:
                target = before.get(key, snapshot)
            self._apply(row, target)
            versions[key] = int(row.version or 1) if hasattr(row, "version") else item_snapshot(row) if isinstance(row, MindCanvasItem) else canvas_snapshot(row) if isinstance(row, MindMap) else relation_snapshot(row)
        return {"versions": versions, "events": self._events(operation, versions, "undo")}

    async def redo(self, operation: UndoOperation, user_id):
        after = operation.after_state.get("items", {})
        before = operation.before_state.get("items", {})
        expected = operation.after_state.get("undo_versions", {})
        await self._preflight(operation, user_id, redo=True)
        versions = {}
        for key in (after if operation.action in {"create", "delete"} else before):
            _, row = await self._load(user_id, key)
            # create 的 redo 是恢复为创建后的 live 状态；delete 的 redo 才使用删除快照。
            target = after[key]
            self._apply(row, target)
            versions[key] = int(row.version or 1) if hasattr(row, "version") else item_snapshot(row) if isinstance(row, MindCanvasItem) else canvas_snapshot(row) if isinstance(row, MindMap) else relation_snapshot(row)
        return {"versions": versions, "events": self._events(operation, versions, "redo")}

    @staticmethod
    def _events(operation, versions, mode):
        ids = [int(key.split(":", 1)[1]) for key in versions]
        op = "update"
        if operation.action in {"create", "delete"}:
            op = "delete" if (operation.action == "create") == (mode == "undo") else "create"
        return [{"resource": "mind", "operation": op, "entity_ids": ids, "origin": f"undo:{operation.id}"}]
