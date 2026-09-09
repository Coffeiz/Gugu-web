"""项目与日历的撤回适配器。

项目删除使用软删除保留关联数据；日历事件删除保留事件和提醒任务，提醒只切换启用状态。
这样撤回不需要重建主键，也不会把提醒关系拆成另一套历史机制。
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import re

from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import CalendarEvent, File, Folder, Project, ScheduledTask, UndoOperation
from app.services.storage import get_storage
from app.services.storage.trash import move_file_to_trash, restore_file_storage
from app.services.undo.service import UndoConflict, UndoError


def project_snapshot(project: Project) -> dict:
    return {
        "id": project.id,
        "name": project.name,
        "client": project.client,
        "status": project.status,
        "start_date": project.start_date,
        "deadline": project.deadline,
        "color": project.color,
        "progress": project.progress,
        "stages": deepcopy(project.stages),
        "current_stage": project.current_stage,
        "priority": project.priority,
        "archived": project.archived,
        "done_at": project.done_at.isoformat() if project.done_at else None,
        "version": int(project.version or 1),
        "deleted_at": project.deleted_at.isoformat() if project.deleted_at else None,
    }


def event_snapshot(event: CalendarEvent) -> dict:
    return {
        "id": event.id,
        "title": event.title,
        "date": event.date,
        "time": event.time,
        "end_time": event.end_time,
        "type": event.type,
        "client": event.client,
        "project_id": event.project_id,
        "description": event.description,
        "version": int(event.version or 1),
        "deleted_at": event.deleted_at.isoformat() if event.deleted_at else None,
    }


def task_snapshot(task: ScheduledTask) -> dict:
    return {"id": task.id, "enabled": bool(task.enabled)}


def domain_state(items: dict[str, dict]) -> dict:
    return {"items": deepcopy(items)}


def domain_ref(kind: str, entity_id: int) -> str:
    return f"{kind}:{entity_id}"


def _parse_datetime(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _project_prefix(project: Project, name: str) -> str:
    safe_name = re.sub(r'[\\/:*?"<>|]', "_", name)
    date_str = project.start_date or project.created_at.strftime("%Y-%m-%d")
    return f"{project.user_id}/项目文件/{date_str[:4]}/{date_str[5:7]}/{safe_name} #{project.id}"


class DomainUndoAdapter:
    def __init__(self, db):
        self.db = db
        self.storage = get_storage()

    async def _load(self, user_id, ref: str):
        kind, raw_id = ref.split(":", 1)
        models = {
            "project": Project,
            "event": CalendarEvent,
            "file": File,
            "folder": Folder,
            "task": ScheduledTask,
        }
        model = models.get(kind)
        if model is None:
            raise UndoError("undo.unsupported", "撤销记录包含未知资源")
        row = await get_owned(self.db, model, int(raw_id), user_id)
        if row is None:
            raise UndoConflict("目标对象已不存在，无法安全撤回")
        return kind, row

    @staticmethod
    def _check_version(row, snapshot: dict) -> None:
        if not hasattr(row, "version"):
            return
        if int(row.version or 1) != int(snapshot.get("version", -1)):
            raise UndoConflict()

    @staticmethod
    def _ordered_refs(items: dict[str, dict], *, undo: bool, project_delete: bool) -> list[tuple[str, dict]]:
        if not project_delete:
            return list(items.items())
        order = ("project", "folder", "file", "event", "task") if undo else ("file", "folder", "event", "project", "task")
        return [(ref, snapshot) for kind in order for ref, snapshot in items.items() if ref.startswith(f"{kind}:")]

    async def _preflight(self, operation: UndoOperation, user_id, *, redo: bool) -> None:
        # undo 校验正向操作完成后的快照；redo 校验上一次 undo 写入的版本。
        items = operation.after_state
        expected_versions = operation.after_state.get("undo_versions", {}) if redo else {}
        project_delete = operation.action == "delete" and operation.resource == "projects"
        for ref, snapshot in self._ordered_refs(items.get("items", {}), undo=not redo, project_delete=project_delete):
            _, row = await self._load(user_id, ref)
            if redo:
                if hasattr(row, "version") and int(row.version or 1) != int(expected_versions.get(ref, -1)):
                    raise UndoConflict()
            elif hasattr(row, "version"):
                self._check_version(row, snapshot)

    async def undo(self, operation: UndoOperation, user_id) -> dict:
        before = operation.before_state.get("items", {})
        after = operation.after_state.get("items", {})
        project_delete = operation.action == "delete" and operation.resource == "projects"
        await self._preflight(operation, user_id, redo=False)
        versions: dict[str, int] = {}
        for ref, snapshot in self._ordered_refs(after, undo=True, project_delete=project_delete):
            kind, row = await self._load(user_id, ref)
            self._check_version(row, snapshot) if hasattr(row, "version") else None
            if kind == "project":
                if operation.action == "create":
                    row.deleted_at = now_utc()
                elif operation.action == "delete":
                    row.deleted_at = None
                else:
                    await self._restore_project(row, before[ref])
                row.version = int(row.version or 1) + 1
            elif kind == "event":
                if operation.action == "create":
                    row.deleted_at = now_utc()
                elif operation.action == "delete":
                    row.deleted_at = None
                else:
                    self._restore_event(row, before[ref])
                row.version = int(row.version or 1) + 1
            elif kind == "file":
                if operation.action == "delete" and operation.resource == "projects":
                    await restore_file_storage(row, self.storage, self.db)
                    row.deleted_at = None
                    row.version = int(row.version or 1) + 1
            elif kind == "folder" and operation.action == "delete" and operation.resource == "projects":
                row.deleted_at = None
                row.version = int(row.version or 1) + 1
            elif kind == "task" and operation.action == "delete" and operation.resource in {"projects", "calendar"}:
                row.enabled = before.get(ref, {}).get("enabled", row.enabled)
            elif kind == "task" and operation.action == "create" and operation.resource == "calendar":
                row.enabled = False
            else:
                raise UndoError("undo.unsupported", "项目或日历操作类型尚未支持撤回")
            versions[ref] = int(row.version or 1) if hasattr(row, "version") else 0
        return {"versions": versions, "events": self._events(operation, versions, "undo")}

    async def redo(self, operation: UndoOperation, user_id) -> dict:
        before = operation.before_state.get("items", {})
        after = operation.after_state.get("items", {})
        project_delete = operation.action == "delete" and operation.resource == "projects"
        expected_versions = operation.after_state.get("undo_versions", {})
        await self._preflight(operation, user_id, redo=True)
        versions: dict[str, int] = {}
        # create/delete 的实体只存在于 after 快照；update 则从 before 找回实体，
        # 再把字段恢复到 after 状态。
        items = after if operation.action in {"create", "delete"} else before
        for ref, snapshot in self._ordered_refs(items, undo=False, project_delete=project_delete):
            kind, row = await self._load(user_id, ref)
            if hasattr(row, "version") and int(row.version or 1) != int(expected_versions.get(ref, -1)):
                raise UndoConflict()
            if kind == "project":
                if operation.action == "create":
                    row.deleted_at = None
                elif operation.action == "delete":
                    row.deleted_at = _parse_datetime(after[ref].get("deleted_at")) or now_utc()
                else:
                    await self._restore_project(row, after[ref])
                row.version = int(row.version or 1) + 1
            elif kind == "event":
                if operation.action == "create":
                    row.deleted_at = None
                elif operation.action == "delete":
                    row.deleted_at = _parse_datetime(after[ref].get("deleted_at")) or now_utc()
                else:
                    self._restore_event(row, after[ref])
                row.version = int(row.version or 1) + 1
            elif kind == "file" and operation.action == "delete" and operation.resource == "projects":
                await move_file_to_trash(self.storage, row)
                row.deleted_at = _parse_datetime(after[ref].get("deleted_at")) or now_utc()
                row.version = int(row.version or 1) + 1
            elif kind == "folder" and operation.action == "delete" and operation.resource == "projects":
                row.deleted_at = _parse_datetime(after[ref].get("deleted_at")) or now_utc()
                row.version = int(row.version or 1) + 1
            elif kind == "task" and operation.action == "delete" and operation.resource in {"projects", "calendar"}:
                row.enabled = False
            elif kind == "task" and operation.action == "create" and operation.resource == "calendar":
                row.enabled = bool(after.get(ref, {}).get("enabled", True))
            else:
                raise UndoError("undo.unsupported", "项目或日历操作类型尚未支持重做")
            versions[ref] = int(row.version or 1) if hasattr(row, "version") else 0
        return {"versions": versions, "events": self._events(operation, versions, "redo")}

    async def _restore_project(self, row: Project, snapshot: dict) -> None:
        old_name = row.name
        target_name = snapshot.get("name", old_name)
        if old_name != target_name:
            old_prefix = _project_prefix(row, old_name)
            new_prefix = _project_prefix(row, target_name)
            await self.storage.rename_dir(old_prefix, new_prefix)
            from sqlalchemy import select
            files = (await self.db.execute(select(File).where(File.project_id == row.id, File.user_id == row.user_id))).scalars().all()
            for file in files:
                if file.storage_key.startswith(old_prefix):
                    file.storage_key = new_prefix + file.storage_key[len(old_prefix):]
        for field in ("name", "client", "status", "start_date", "deadline", "color", "progress", "current_stage", "priority", "archived"):
            if field in snapshot:
                setattr(row, field, snapshot[field])
        row.stages = snapshot.get("stages", [])
        row.done_at = _parse_datetime(snapshot.get("done_at"))
        row.deleted_at = _parse_datetime(snapshot.get("deleted_at"))

    @staticmethod
    def _restore_event(row: CalendarEvent, snapshot: dict) -> None:
        for field in ("title", "date", "time", "end_time", "type", "client", "project_id", "description"):
            if field in snapshot:
                setattr(row, field, snapshot[field])
        row.deleted_at = _parse_datetime(snapshot.get("deleted_at"))

    @staticmethod
    def _events(operation: UndoOperation, versions: dict[str, int], mode: str) -> list[dict]:
        grouped: dict[str, list[int]] = {}
        for ref in versions:
            kind, raw_id = ref.split(":", 1)
            resource = {
                "project": "projects", "event": "calendar", "file": "files", "folder": "files",
                "task": "scheduled_tasks",
            }.get(kind)
            if resource:
                grouped.setdefault(resource, []).append(int(raw_id))
        operation_name = "update"
        if operation.action in {"create", "delete"}:
            operation_name = "delete" if (operation.action == "create") == (mode == "undo") else "create"
        return [
            {"resource": resource, "operation": operation_name, "entity_ids": ids, "origin": f"undo:{operation.id}"}
            for resource, ids in grouped.items()
        ]
