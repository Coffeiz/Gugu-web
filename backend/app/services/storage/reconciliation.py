"""文件库物理对象核对与修复所需的存储/数据库协调。"""
from __future__ import annotations

import mimetypes
import re
import uuid

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import File, Folder, Project, User
from app.services.filesync.protocol import record_canonical_file_delete
from app.services.storage.folder_tree import SqlAlchemyFolderTree


def is_internal_storage_key(value: str) -> bool:
    """判断对象是否由运行时而非 File 表管理。"""
    key = str(value)
    parts = [part for part in key.split("/") if part]
    user_path_parts = parts[2:] if len(parts) >= 3 and parts[0] == "u" else parts[1:]
    internal_user_root = bool(user_path_parts) and user_path_parts[0] in {
        ".system", ".agent", "shell", ".voice", ".video_cache", ".data-portability",
        "workspace",
    }
    return (
        internal_user_root
        or key.startswith("_analytics/")
        or ".agent/" in key
        or ".chat_staging" in key
        or ".thumbs" in key
        or "_thumb" in key
        or ".thumbcache" in key
        or key.startswith("avatars/")
    )


def parse_path_migration_key(key: str) -> dict | None:
    """解析 path-mirror key 的稳定归属部分。"""
    parts = key.split("/")
    if len(parts) < 3 or any(part in {"", ".", ".."} for part in parts):
        return None
    try:
        user_id = str(uuid.UUID(parts[0]))
    except ValueError:
        return None
    name, dot, ext = parts[-1].rpartition(".")
    if not dot:
        name, ext = parts[-1], ""
    if parts[1] == "个人文件":
        return {
            "user_id": user_id, "space": "personal", "project_id": None,
            "folder_parts": parts[2:-1], "display_name": name, "ext": ext.lower(),
        }
    if parts[1] != "项目文件":
        return None
    project_id = project_index = project_name = None
    for index, part in enumerate(parts[2:-1], start=2):
        match = re.search(r"#(\d+)$", part)
        if match:
            project_id = int(match.group(1))
            project_index = index
            project_name = part[:match.start()].rstrip()
            break
    if project_id is None or project_index is None or not project_name or len(project_name) > 200:
        return None
    start_date = None
    if project_index >= 4:
        year, month = parts[project_index - 2:project_index]
        if year.isdigit() and len(year) == 4 and month.isdigit() and 1 <= int(month) <= 12:
            start_date = f"{int(year):04d}-{int(month):02d}-01"
    return {
        "user_id": user_id, "space": "project", "project_id": project_id,
        "project_name": project_name, "project_start_date": start_date,
        "folder_parts": parts[project_index + 1:-1], "display_name": name,
        "ext": ext.lower(),
    }


def same_file_scope(file: File, parsed: dict) -> bool:
    return file.space == parsed["space"] and file.project_id == parsed["project_id"]


def _format_file_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


async def resolve_import_folder(
    db: AsyncSession,
    user_id,
    project_id: int | None,
    folder_parts: list[str],
    *,
    create_missing: bool = False,
) -> int | None:
    """按原始物理路径解析活动目录；可选地补建缺失目录。"""
    parent_id = None
    tree = SqlAlchemyFolderTree(db)
    for index, name in enumerate(folder_parts):
        active = (await db.execute(select(Folder.id).where(
            Folder.user_id == user_id,
            Folder.project_id == project_id if project_id is not None else Folder.project_id.is_(None),
            Folder.parent_id == parent_id if parent_id is not None else Folder.parent_id.is_(None),
            Folder.name == name,
            Folder.deleted_at.is_(None),
        ))).scalars().first()
        if active is not None:
            parent_id = active
            continue
        if not create_missing:
            return None
        deleted = (await db.execute(select(Folder.id).where(
            Folder.user_id == user_id,
            Folder.project_id == project_id if project_id is not None else Folder.project_id.is_(None),
            Folder.parent_id == parent_id if parent_id is not None else Folder.parent_id.is_(None),
            Folder.name == name,
            Folder.deleted_at.is_not(None),
        ))).scalars().first()
        if deleted is not None or any(not part or len(part) > 200 for part in folder_parts):
            return None
        async with db.begin_nested():
            for missing_name in folder_parts[index:]:
                folder = await tree.create(
                    user_id, name=missing_name, parent_id=parent_id,
                    project_id=project_id,
                )
                parent_id = folder.id
        break
    return parent_id


async def import_orphan_file(db: AsyncSession, key: str, storage) -> tuple[bool, str | None]:
    """按已验证的 path-mirror key 导入孤儿文件，不猜测不完整的归属。"""
    parsed = parse_path_migration_key(key)
    if parsed is None:
        return False, "存储路径无法解析"
    uid_text = parsed["user_id"]
    uid = uuid.UUID(uid_text)
    if await db.get(User, uid) is None:
        return False, "文件所有者不存在"
    existing = (await db.execute(select(File).where(File.storage_key == key))).scalars().first()
    if existing is not None:
        return False, "文件记录已存在，请重新扫描"
    info = await storage.stat(key)
    if info is None:
        return False, "物理文件已不存在，请重新扫描"

    fname = key.rsplit("/", 1)[-1]
    name, _, ext = fname.rpartition(".")
    if not name:
        name, ext = fname, ""
    project_id = parsed["project_id"]
    project = await db.get(Project, project_id) if project_id is not None else None
    if project_id is not None and project is not None:
        if str(project.user_id) != uid_text:
            return False, "所属项目不存在或不属于文件所有者"
        if project.deleted_at is not None:
            return False, "所属项目在回收站中，请先恢复项目后重试"

    class ImportRejected(Exception):
        pass

    try:
        async with db.begin_nested():
            if project_id is not None and project is None:
                if not parsed.get("project_name"):
                    raise ImportRejected("项目路径不完整，无法恢复原项目")
                if db.bind.dialect.name == "postgresql":
                    await db.execute(text("LOCK TABLE projects IN EXCLUSIVE MODE"))
                    project = await db.get(Project, project_id)
                    if project is not None:
                        if str(project.user_id) != uid_text:
                            raise ImportRejected("所属项目不存在或不属于文件所有者")
                        if project.deleted_at is not None:
                            raise ImportRejected("所属项目在回收站中，请先恢复项目后重试")
                if project is None:
                    project = Project(
                        id=project_id, user_id=uid, name=parsed["project_name"],
                        start_date=parsed.get("project_start_date"),
                    )
                    db.add(project)
                    await db.flush()
                    if db.bind.dialect.name == "postgresql":
                        sequence = await db.scalar(text(
                            "SELECT pg_get_serial_sequence('projects', 'id')"
                        ))
                        if sequence:
                            current = await db.scalar(text(
                                "SELECT pg_sequence_last_value(CAST(:sequence AS regclass))"
                            ), {"sequence": sequence})
                            if current is None or current < project_id:
                                await db.execute(text(
                                    "SELECT setval(CAST(:sequence AS regclass), :value, true)"
                                ), {"sequence": sequence, "value": project_id})
            folder_id = await resolve_import_folder(
                db, uid, project_id, parsed["folder_parts"], create_missing=True,
            )
            if parsed["folder_parts"] and folder_id is None:
                raise ImportRejected("目录路径无效，或对应目录已删除")
            db.add(File(
                user_id=uid, display_name=name, ext=ext.lower(), space=parsed["space"],
                project_id=project_id, folder_id=folder_id, storage_key=key,
                size=_format_file_size(info.size), size_bytes=info.size,
                mime_type=mimetypes.guess_type(fname)[0],
            ))
    except ImportRejected as exc:
        return False, str(exc)
    return True, None


def storage_repair_error(error: Exception) -> str:
    if isinstance(error, PermissionError):
        return "权限不足；未更改记录，请检查存储目录权限后重试"
    if isinstance(error, FileNotFoundError):
        return "物理文件已不存在，请重新扫描"
    return f"处理失败（{type(error).__name__}）；记录未更改，请重新扫描后重试"


async def delete_ghost_record(db: AsyncSession, file_id: int, storage) -> tuple[File | None, str | None]:
    """复核物理对象缺失后移除对应 File 行并记录规范删除事件。"""
    file = await db.get(File, file_id)
    if file is None:
        return None, "文件记录已不存在，请重新扫描"
    if is_internal_storage_key(file.storage_key):
        return None, "该路径不属于 File 文件库对账范围"
    try:
        if await storage.stat(file.storage_key) is not None:
            return None, "物理文件已存在，请重新扫描"
        async with db.begin_nested():
            await record_canonical_file_delete(
                db, user_id=file.user_id, storage_key=file.storage_key,
                entity_id=file.id, version=file.version, change_id=uuid.uuid4().hex,
            )
            await db.delete(file)
            await db.flush()
    except Exception as error:
        return None, storage_repair_error(error)
    return file, None
