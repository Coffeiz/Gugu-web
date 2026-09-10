"""文件库撤销适配器：只调用已有 FileService/回收站/Storage 原语。"""
from __future__ import annotations

from copy import deepcopy

from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import File, Folder, UndoOperation
from app.services.files.actions import delete_file as delete_file_action
from app.services.storage import get_storage
from app.services.storage.file_service import FileService
from app.services.storage.trash import restore_file_storage
from app.services.undo.service import UndoConflict, UndoError


def file_snapshot(file: File) -> dict:
    return {
        "id": file.id,
        "display_name": file.display_name,
        "ext": file.ext,
        "space": file.space,
        "project_id": file.project_id,
        "folder_id": file.folder_id,
        "workspace_directory_id": file.workspace_directory_id,
        "stage_name": file.stage_name,
        "mind_map_id": file.mind_map_id,
        "storage_key": file.storage_key,
        "version": int(file.version or 1),
        "size": file.size,
        "size_bytes": file.size_bytes,
        "mime_type": file.mime_type,
        "img_width": file.img_width,
        "img_height": file.img_height,
        "deleted_at": file.deleted_at.isoformat() if file.deleted_at else None,
    }


def folder_snapshot(folder: Folder) -> dict:
    return {
        "id": folder.id,
        "name": folder.name,
        "project_id": folder.project_id,
        "workspace_directory_id": folder.workspace_directory_id,
        "parent_id": folder.parent_id,
        "version": int(folder.version or 1),
        "deleted_at": folder.deleted_at.isoformat() if folder.deleted_at else None,
    }


def state_items(state: dict) -> dict[str, dict]:
    return state.get("items", {}) if isinstance(state, dict) else {}


def operation_state(items: dict[str, dict]) -> dict:
    return {"items": deepcopy(items)}


def ref_for(kind: str, entity_id: int) -> str:
    return f"{kind}:{entity_id}"


async def save_content_artifacts(operation: UndoOperation, storage, user_id, ref: str,
                                 before: bytes, after: bytes) -> None:
    """把正文版本存到存储后端，数据库只保存内部引用，不把二进制塞进 JSON。"""
    prefix = f"{user_id}/.undo/{operation.id}/{ref.replace(':', '-') }"
    before_key = f"{prefix}/before"
    after_key = f"{prefix}/after"
    await storage.put(before_key, before, "application/octet-stream")
    await storage.put(after_key, after, "application/octet-stream")
    refs = deepcopy(operation.artifact_refs or {})
    refs[ref] = {"before_key": before_key, "after_key": after_key}
    operation.artifact_refs = refs


class FileUndoAdapter:
    def __init__(self, db):
        self.db = db
        self.storage = get_storage()

    async def _load(self, user_id, ref: str):
        kind, raw_id = ref.split(":", 1)
        model = File if kind == "file" else Folder
        row = await get_owned(self.db, model, int(raw_id), user_id)
        if row is None:
            raise UndoConflict("目标对象已不存在，无法安全撤回")
        return kind, row

    @staticmethod
    def _check_version(row, expected: dict):
        if int(row.version or 1) != int(expected.get("version", -1)):
            raise UndoConflict()

    async def _preflight(self, operation: UndoOperation, user_id, *, redo: bool) -> None:
        """先完整检查一个 group，避免批量撤回做到一半才发现后续对象冲突。"""
        refs = state_items(
            operation.after_state if redo and operation.action in {"create", "copy", "delete"}
            else operation.before_state if redo else operation.after_state
        )
        expected_versions = operation.after_state.get("undo_versions", {}) if redo else {}
        for ref, snapshot in refs.items():
            _, row = await self._load(user_id, ref)
            if redo:
                expected_version = expected_versions.get(ref)
                if expected_version is None or int(row.version or 1) != int(expected_version):
                    raise UndoConflict()
            else:
                self._check_version(row, snapshot)

    async def undo(self, operation: UndoOperation, user_id) -> dict:
        before = state_items(operation.before_state)
        after = state_items(operation.after_state)
        versions: dict[str, int] = {}

        await self._preflight(operation, user_id, redo=False)

        for ref, expected in after.items():
            kind, row = await self._load(user_id, ref)
            self._check_version(row, expected)
            if kind == "file" and operation.action in {"create", "copy"}:
                if not await delete_file_action(self.db, self.storage, user_id, row.id, now_utc()):
                    raise UndoConflict("文件已经不在可撤回状态")
            elif kind == "file" and operation.action == "delete":
                await restore_file_storage(row, self.storage, self.db)
                row.deleted_at = None
                row.version = int(row.version or 1) + 1
            elif kind == "file" and operation.action in {"update", "move", "rename", "overwrite"}:
                await self._restore_file(row, before[ref], operation, ref, redo=False)
            elif kind == "folder" and operation.action == "create":
                await FileService(self.db).delete_folder(user_id, row.id)
            elif kind == "folder" and operation.action == "delete":
                await FileService(self.db).restore_folder(user_id, row.id)
            elif kind == "folder" and operation.action in {"update", "move", "rename"}:
                await self._restore_folder(row, before[ref], user_id)
            else:
                raise UndoError("undo.unsupported", "文件操作类型尚未支持撤回")
            versions[ref] = int(row.version or 1)

        return {"versions": versions, "event": self._event(operation, list(versions), "undo")}

    async def redo(self, operation: UndoOperation, user_id) -> dict:
        before = state_items(operation.before_state)
        after = state_items(operation.after_state)
        expected_versions = operation.after_state.get("undo_versions", {})
        versions: dict[str, int] = {}
        await self._preflight(operation, user_id, redo=True)
        redo_items = after if operation.action in {"create", "copy", "delete"} else before
        for ref, expected in redo_items.items():
            kind, row = await self._load(user_id, ref)
            expected_version = expected_versions.get(ref)
            if expected_version is None or int(row.version or 1) != int(expected_version):
                raise UndoConflict()
            if kind == "file" and operation.action in {"create", "copy"}:
                if row.deleted_at is None:
                    raise UndoConflict("文件状态已变化，无法重做")
                await restore_file_storage(row, self.storage, self.db)
                row.deleted_at = None
                row.version = int(row.version or 1) + 1
            elif kind == "file" and operation.action == "delete":
                if row.deleted_at is None:
                    raise UndoConflict("文件状态已变化，无法重做")
                if not await delete_file_action(self.db, self.storage, user_id, row.id, now_utc()):
                    raise UndoConflict("文件状态已变化，无法重做")
                row.version = int(row.version or 1) + 1
            elif kind == "file" and operation.action in {"update", "move", "rename", "overwrite"}:
                await self._restore_file(row, after[ref], operation, ref, redo=True)
            elif kind == "folder" and operation.action == "create":
                if row.deleted_at is None:
                    raise UndoConflict("文件夹状态已变化，无法重做")
                await FileService(self.db).restore_folder(user_id, row.id)
            elif kind == "folder" and operation.action == "delete":
                await FileService(self.db).delete_folder(user_id, row.id)
            elif kind == "folder" and operation.action in {"update", "move", "rename"}:
                await self._restore_folder(row, after[ref], user_id)
            else:
                raise UndoError("undo.unsupported", "文件操作类型尚未支持重做")
            versions[ref] = int(row.version or 1)
        return {"versions": versions, "event": self._event(operation, list(versions), "redo")}

    async def _restore_file(self, row: File, snapshot: dict, operation: UndoOperation, ref: str, *, redo: bool) -> None:
        artifact = (operation.artifact_refs or {}).get(ref, {})
        key = "after_key" if redo else "before_key"
        if key in artifact:
            await self.storage.put(row.storage_key, await self.storage.get(artifact[key]), row.mime_type or "application/octet-stream")
        service = FileService(self.db)
        result = await service.update_file(
            row.user_id,
            row.id,
            display_name=snapshot.get("display_name"),
            stage_name=snapshot.get("stage_name"),
            folder_id=snapshot.get("folder_id"),
            project_id=snapshot.get("project_id"),
            folder_set=True,
            project_set=True,
            workspace_directory_id=snapshot.get("workspace_directory_id"),
            workspace_directory_set=True,
        )
        row.version = int(result.file.version or 1)

    async def _restore_folder(self, row: Folder, snapshot: dict, user_id) -> None:
        if row.name != snapshot.get("name"):
            await FileService(self.db).rename_folder(user_id, row.id, snapshot["name"], client_version=row.version)
        await FileService(self.db).move_folder(
            user_id,
            row.id,
            snapshot.get("parent_id"),
            client_version=row.version,
            target_project_id=snapshot.get("project_id"),
            target_project_set=True,
            target_workspace_directory_id=snapshot.get("workspace_directory_id"),
            target_workspace_set=True,
        )
        await self.db.refresh(row)

    @staticmethod
    def _event(operation: UndoOperation, entity_ids: list[str], mode: str) -> dict:
        if operation.action in {"create", "copy"}:
            event_operation = "delete" if mode == "undo" else "create"
        elif operation.action == "delete":
            event_operation = "create" if mode == "undo" else "delete"
        else:
            event_operation = "update"
        return {
            "resource": operation.resource,
            "operation": event_operation,
            "entity_ids": [int(ref.split(":", 1)[1]) for ref in entity_ids],
            "origin": f"undo:{operation.id}",
        }
