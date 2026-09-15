"""文件库压缩与解压服务。

该模块只处理 personal/project/workspace 文件库条目。API 与 Agent 共用本服务；
压缩内容通过分块存储读取，ZIP/TAR 输入输出使用临时文件，避免把大对象整体放进内存。
"""
from __future__ import annotations

import asyncio
import hashlib
import mimetypes
import os
import re
import stat
import tarfile
import tempfile
import zipfile
from dataclasses import dataclass, replace
from typing import BinaryIO, Iterable
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.core.ownership import get_owned
from app.core.redaction import diag_log
from app.models import File, Folder, Project, WorkspaceDirectory
from app.services.filesync.protocol import record_canonical_file_change
from app.services.storage import OSSStorageBackend, StorageBackend, get_storage
from app.services.storage.key_strategy import KeyContext, PathMirrorStrategy
from app.services.storage.keys import compose_logical_path
from app.services.storage.quota_ledger import FILE_LIBRARY, get_quota, reconcile_user_storage, record_usage

MAX_COMPRESS_SOURCE_BYTES = 512 * 1024 * 1024
MAX_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 10_000
_CHUNK_SIZE = 1024 * 1024
_DRIVE_PREFIX = re.compile(r"^[a-zA-Z]:")
_UNSUPPORTED_FORMAT = "不支持的压缩格式"
_CORRUPT_ARCHIVE = "压缩包损坏"


@dataclass(frozen=True)
class _Target:
    space: str
    project_id: int | None
    workspace_directory_id: int | None
    folder_id: int | None
    project: Project | None
    workspace_directory: WorkspaceDirectory | None
    folder_path: str


@dataclass(frozen=True)
class _Source:
    kind: str
    row: File | Folder
    parent_id: int | None


@dataclass(frozen=True)
class _ArchiveMember:
    path: str
    is_dir: bool
    size: int
    source: object
    skipped: bool = False


def _scope_for_file(file: File) -> tuple[str, int | None, int | None]:
    space = file.space or ("project" if file.project_id is not None else "personal")
    return space, file.project_id, file.workspace_directory_id


def _scope_for_folder(folder: Folder) -> tuple[str, int | None, int | None]:
    if folder.workspace_directory_id is not None:
        return "workspace", None, folder.workspace_directory_id
    if folder.project_id is not None:
        return "project", folder.project_id, None
    return "personal", None, None


async def _resolve_target(
    db: AsyncSession,
    user_id,
    *,
    space: str,
    project_id: int | None,
    workspace_directory_id: int | None,
    folder_id: int | None,
) -> _Target:
    if space not in {"personal", "project", "workspace"}:
        raise Invalid("archive.unsupported_space", "该文件空间暂不支持压缩与解压")
    if space == "project":
        project = await get_owned(db, Project, project_id, user_id) if project_id is not None else None
        if project is None:
            raise NotFound("project.not_found", "项目不存在")
        project_id = project.id
        workspace_directory_id = None
    else:
        project = None
        if space == "personal":
            project_id = None
            workspace_directory_id = None
    workspace_directory = None
    if space == "workspace":
        workspace_directory = (
            await get_owned(db, WorkspaceDirectory, workspace_directory_id, user_id)
            if workspace_directory_id is not None else None
        )
        if workspace_directory is None or workspace_directory.deleted_at is not None:
            raise NotFound("workspace.not_found", "Workspace 不存在")

    folder_path = ""
    if folder_id is not None:
        folder = await get_owned(db, Folder, folder_id, user_id)
        if (
            folder is None
            or folder.deleted_at is not None
            or folder.project_id != project_id
            or folder.workspace_directory_id != workspace_directory_id
        ):
            raise NotFound("folder.not_found", "目标文件夹不存在")
        parts: list[str] = []
        current = folder
        visited: set[int] = set()
        while current is not None:
            if (
                current.id in visited
                or current.deleted_at is not None
                or current.project_id != project_id
                or current.workspace_directory_id != workspace_directory_id
            ):
                raise Invalid("folder.invalid_tree", "目标文件夹层级无效")
            visited.add(current.id)
            parts.append(current.name)
            if current.parent_id is None:
                break
            current = await get_owned(db, Folder, current.parent_id, user_id)
            if current is None:
                raise Invalid("folder.invalid_tree", "目标文件夹层级无效")
        folder_path = "/".join(reversed(parts))

    return _Target(
        space=space,
        project_id=project_id,
        workspace_directory_id=workspace_directory_id,
        folder_id=folder_id,
        project=project,
        workspace_directory=workspace_directory,
        folder_path=folder_path,
    )


async def _target_for_file(db: AsyncSession, user_id, file: File, folder_id: int | None) -> _Target:
    space, project_id, workspace_id = _scope_for_file(file)
    return await _resolve_target(
        db, user_id, space=space, project_id=project_id,
        workspace_directory_id=workspace_id, folder_id=folder_id,
    )


async def _quota_remaining(db: AsyncSession, user_id) -> int:
    await reconcile_user_storage(db, user_id)
    row = await get_quota(db, user_id, FILE_LIBRARY)
    return max(0, int(row.limit_bytes) - int(row.used_bytes) - int(row.reserved_bytes))


def _logical_path(target: _Target, folder_path: str | None = None) -> str:
    project_name = project_year = project_month = ""
    if target.project is not None:
        project_name = target.project.name
        date_value = target.project.start_date or target.project.created_at.strftime("%Y-%m-%d")
        project_year, project_month = date_value[:4], date_value[5:7]
    return compose_logical_path(
        target.space,
        project_name=project_name,
        project_id=target.project_id or 0,
        project_year=project_year,
        project_month=project_month,
        folder_path=target.folder_path if folder_path is None else folder_path,
        workspace_directory_name=(target.workspace_directory.directory_name
                                  if target.workspace_directory else ""),
    )


async def _physical_folder_key(storage: StorageBackend, user_id, target: _Target, folder_path: str) -> str:
    # 目录在本地存储中有物理骨架；对象存储的 ensure_folder 是 no-op。
    return f"{user_id}/{_logical_path(target, folder_path)}"


def _entry_name(file: File) -> str:
    return f"{file.display_name}.{file.ext}" if file.ext else file.display_name


def _validate_component(name: str) -> str:
    if (
        not name or name in {".", ".."} or "\x00" in name
        or "/" in name or "\\" in name or _DRIVE_PREFIX.match(name)
    ):
        raise Invalid("archive.unsafe_path", "所选内容包含无效名称，无法压缩")
    return name


async def _cleanup_created(
    storage: StorageBackend,
    file_keys: list[str],
    folder_keys: list[str] = (),
) -> None:
    for key in file_keys:
        try:
            await storage.delete(key)
        except Exception as error:
            diag_log("app.services.files.archive.cleanup_file", error)
    for key in reversed(folder_keys):
        try:
            await storage.remove_folder(key)
        except Exception as error:
            diag_log("app.services.files.archive.cleanup_folder", error)


def _unique_name(name: str, occupied: set[str], *, is_file: bool) -> str:
    if name not in occupied:
        occupied.add(name)
        return name
    if is_file:
        stem, suffix = os.path.splitext(name)
        if not stem:
            stem, suffix = name, ""
    else:
        stem, suffix = name, ""
    number = 2
    candidate = f"{stem} ({number}){suffix}"
    while candidate in occupied:
        number += 1
        candidate = f"{stem} ({number}){suffix}"
    occupied.add(candidate)
    return candidate


async def _occupied_names(db: AsyncSession, user_id, target: _Target, folder_id: int | None) -> set[str]:
    files = (await db.execute(select(File).where(
        File.user_id == user_id, File.folder_id == folder_id,
        File.project_id == target.project_id,
        File.workspace_directory_id == target.workspace_directory_id,
        File.deleted_at.is_(None),
    ))).scalars().all()
    folders = (await db.execute(select(Folder.name).where(
        Folder.user_id == user_id, Folder.parent_id == folder_id,
        Folder.project_id == target.project_id,
        Folder.workspace_directory_id == target.workspace_directory_id,
        Folder.deleted_at.is_(None),
    ))).scalars().all()
    return {_entry_name(file) for file in files} | set(folders)


def _split_filename(filename: str) -> tuple[str, str]:
    stem, extension = os.path.splitext(filename)
    if not stem or not extension:
        return filename, ""
    ext = extension[1:].lower()
    return stem, ext


async def _store_file(
    db: AsyncSession,
    storage: StorageBackend,
    user_id,
    target: _Target,
    *,
    folder_id: int | None,
    folder_path: str,
    display_name: str,
    ext: str,
    mime_type: str,
    source: BinaryIO,
    size: int,
    digest: str,
    created_keys: list[str],
) -> File:
    logical_path = _logical_path(target, folder_path)
    key_strategy = PathMirrorStrategy()
    storage_key = key_strategy.build_key(KeyContext(
        user_id=user_id, file_id=None, name=display_name, ext=ext, logical_path=logical_path,
    ))
    if await storage.exists(storage_key):
        # DB 与物理存储短暂不一致时也不覆盖孤儿对象。
        match = re.match(r"^(.*) \((\d+)\)$", display_name)
        base_name = match.group(1) if match else display_name
        number = int(match.group(2)) + 1 if match else 2
        while True:
            candidate = f"{base_name} ({number})"
            key = key_strategy.build_key(KeyContext(
                user_id=user_id, file_id=None, name=candidate, ext=ext, logical_path=logical_path,
            ))
            if not await storage.exists(key):
                display_name, storage_key = candidate, key
                break
            number += 1
    source.seek(0)
    await storage.put_stream(storage_key, source, size, mime_type)
    created_keys.append(storage_key)
    file = File(
        user_id=user_id,
        display_name=display_name,
        ext=ext,
        space=target.space,
        project_id=target.project_id,
        workspace_directory_id=target.workspace_directory_id,
        folder_id=folder_id,
        stage_name="",
        storage_key=storage_key,
        storage_backend="oss" if isinstance(storage, OSSStorageBackend) else "local",
        size=(f"{size / 1_000_000:.1f} MB" if size >= 1_000_000 else f"{size / 1024:.0f} KB"),
        size_bytes=size,
        mime_type=mime_type,
    )
    db.add(file)
    await db.flush()
    await record_canonical_file_change(
        db, user_id=user_id, storage_key=storage_key, observed_fingerprint=digest,
    )
    return file


async def _commit_usage(db: AsyncSession, user_id, size: int, operation: str) -> None:
    try:
        await record_usage(
            db, user_id, category=FILE_LIBRARY, delta_bytes=size,
            operation=operation, resource_type="archive", resource_id=uuid4().hex,
            idempotency_key=f"{operation}:{uuid4().hex}",
        )
    except ValueError as error:
        if str(error) == "存储空间已满":
            raise Conflict("storage.full", "存储空间不足") from error
        raise


async def _file_digest(source: BinaryIO) -> tuple[int, str]:
    def calculate() -> tuple[int, str]:
        source.seek(0)
        digest = hashlib.sha256()
        size = 0
        while chunk := source.read(_CHUNK_SIZE):
            size += len(chunk)
            digest.update(chunk)
        source.seek(0)
        return size, digest.hexdigest()
    return await asyncio.to_thread(calculate)


async def _collect_selected(
    db: AsyncSession,
    user_id,
    file_ids: Iterable[int],
    folder_ids: Iterable[int],
) -> tuple[list[File], list[Folder]]:
    file_ids = list(dict.fromkeys(file_ids))
    folder_ids = list(dict.fromkeys(folder_ids))
    if not file_ids and not folder_ids:
        raise Invalid("archive.empty_selection", "请先选择要压缩的文件或文件夹")
    files = list((await db.execute(select(File).where(
        File.id.in_(file_ids), File.user_id == user_id, File.deleted_at.is_(None),
    ))).scalars().all()) if file_ids else []
    folders = list((await db.execute(select(Folder).where(
        Folder.id.in_(folder_ids), Folder.user_id == user_id, Folder.deleted_at.is_(None),
    ))).scalars().all()) if folder_ids else []
    if len(files) != len(file_ids) or len(folders) != len(folder_ids):
        raise NotFound("archive.source_not_found", "所选文件或文件夹不存在")
    files_by_id = {row.id: row for row in files}
    folders_by_id = {row.id: row for row in folders}
    files = [files_by_id[item_id] for item_id in file_ids]
    folders = [folders_by_id[item_id] for item_id in folder_ids]
    scopes = {_scope_for_file(row) for row in files} | {_scope_for_folder(row) for row in folders}
    if len(scopes) != 1:
        raise Invalid("archive.cross_space", "不能跨空间压缩")
    scope = next(iter(scopes))
    if scope[0] not in {"personal", "project", "workspace"}:
        raise Invalid("archive.unsupported_space", "该文件空间暂不支持压缩与解压")
    return files, folders


async def _folder_descendants(db: AsyncSession, user_id, folder_id: int) -> list[Folder]:
    result: list[Folder] = []
    frontier = [folder_id]
    visited: set[int] = set()
    while frontier:
        rows = list((await db.execute(select(Folder).where(
            Folder.user_id == user_id, Folder.parent_id.in_(frontier), Folder.deleted_at.is_(None),
        ).order_by(Folder.name, Folder.id))).scalars().all())
        frontier = []
        for row in rows:
            if row.id not in visited:
                visited.add(row.id)
                result.append(row)
                frontier.append(row.id)
    root = await get_owned(db, Folder, folder_id, user_id)
    return ([root] if root else []) + result


async def _build_compression_entries(
    db: AsyncSession,
    user_id,
    files: list[File],
    folders: list[Folder],
) -> list[tuple[str, File | None]]:
    # 选中某个目录后，不再重复打包其子目录或同时单独选中的内部文件。
    folder_by_id = {folder.id: folder for folder in folders}
    root_folders: list[Folder] = []
    for folder in folders:
        parent_id = folder.parent_id
        nested = False
        visited: set[int] = set()
        while parent_id is not None and parent_id not in visited:
            if parent_id in folder_by_id:
                nested = True
                break
            visited.add(parent_id)
            parent = await get_owned(db, Folder, parent_id, user_id)
            parent_id = parent.parent_id if parent else None
        if not nested:
            root_folders.append(folder)

    root_descendants: dict[int, list[Folder]] = {}
    covered_folder_ids: set[int] = set()
    for root in root_folders:
        tree = await _folder_descendants(db, user_id, root.id)
        if any(_scope_for_folder(folder) != _scope_for_folder(root) for folder in tree):
            raise Invalid("archive.cross_space", "文件夹层级跨越文件空间，无法压缩")
        root_descendants[root.id] = tree
        covered_folder_ids.update(folder.id for folder in tree)

    file_roots = [file for file in files if file.folder_id not in covered_folder_ids]
    entries: list[tuple[str, File | None]] = []
    root_occupied: set[str] = set()
    for file in file_roots:
        filename = _validate_component(_entry_name(file))
        entries.append((_unique_name(filename, root_occupied, is_file=True), file))

    for root in root_folders:
        root_name = _unique_name(_validate_component(root.name), root_occupied, is_file=False)
        entries.append((f"{root_name}/", None))
        by_parent: dict[int | None, list[Folder]] = {}
        by_id = {folder.id: folder for folder in root_descendants[root.id]}
        for folder in root_descendants[root.id]:
            by_parent.setdefault(folder.parent_id, []).append(folder)
        async def walk(folder: Folder, archive_path: str) -> None:
            child_occupied: set[str] = set()
            children = by_parent.get(folder.id, [])
            child_files = list((await db.execute(select(File).where(
                File.user_id == user_id, File.folder_id == folder.id, File.deleted_at.is_(None),
            ).order_by(File.display_name, File.ext, File.id))).scalars().all())
            # File/folder sibling collisions are resolved in a stable archive order.
            for child in children:
                child_name = _unique_name(_validate_component(child.name), child_occupied, is_file=False)
                child_path = f"{archive_path}{child_name}/"
                entries.append((child_path, None))
                await walk(child, child_path)
            for file in child_files:
                name = _unique_name(_validate_component(_entry_name(file)), child_occupied, is_file=True)
                entries.append((f"{archive_path}{name}", file))
        await walk(root, f"{root_name}/")
    return entries


async def compress_files(
    db: AsyncSession,
    user_id,
    *,
    file_ids: Iterable[int] = (),
    folder_ids: Iterable[int] = (),
    name: str | None = None,
    folder_id: int | None = None,
    use_source_folder: bool = True,
    storage: StorageBackend | None = None,
) -> File:
    """将同空间的文件/文件夹递归打包为 ZIP，并落为普通 File 行。"""
    storage = storage or get_storage()
    files, folders = await _collect_selected(db, user_id, file_ids, folder_ids)
    scope = next(iter({_scope_for_file(row) for row in files} | {_scope_for_folder(row) for row in folders}))
    first = files[0] if files else None
    first_folder = folders[0] if folders else None
    default_folder_id = first.folder_id if first is not None else first_folder.parent_id
    target_folder_id = default_folder_id if use_source_folder and folder_id is None else folder_id
    target = await _resolve_target(
        db, user_id, space=scope[0], project_id=scope[1], workspace_directory_id=scope[2],
        folder_id=target_folder_id,
    )
    entries = await _build_compression_entries(db, user_id, files, folders)
    source_bytes = sum(file.size_bytes for _, file in entries if file is not None)
    if source_bytes > MAX_COMPRESS_SOURCE_BYTES:
        raise Conflict("archive.source_too_large", "内容过大，暂不支持在库内压缩")
    if not entries:
        raise Invalid("archive.empty_selection", "所选内容为空，无法压缩")
    if name is None or not name.strip():
        first_name = _entry_name(first) if first is not None else first_folder.name
        display_name = os.path.splitext(first_name)[0] or "archive"
    else:
        requested = name.strip()
        if "/" in requested or "\\" in requested or requested in {".", ".."}:
            raise Invalid("archive.invalid_name", "压缩包名称无效")
        display_name = requested[:-4] if requested.lower().endswith(".zip") else requested
    if not display_name or len(display_name) > 300:
        raise Invalid("archive.invalid_name", "压缩包名称无效")

    occupied = await _occupied_names(db, user_id, target, target_folder_id)
    final_name = _unique_name(f"{display_name}.zip", occupied, is_file=True)
    archive_display, archive_ext = _split_filename(final_name)

    savepoint = await db.begin_nested()
    created_keys: list[str] = []
    copied_total = 0
    try:
        remaining = await _quota_remaining(db, user_id)
        with tempfile.TemporaryFile(mode="w+b") as output:
            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                for archive_path, file in entries:
                    if file is None:
                        info = zipfile.ZipInfo(archive_path)
                        info.external_attr = (stat.S_IFDIR | 0o755) << 16
                        info.compress_type = zipfile.ZIP_STORED
                        archive.writestr(info, b"")
                        continue
                    info = zipfile.ZipInfo(archive_path)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    with archive.open(info, "w", force_zip64=True) as target_stream:
                        copied = 0
                        async for chunk in storage.iter_chunks(file.storage_key, chunk_size=_CHUNK_SIZE):
                            copied += len(chunk)
                            copied_total += len(chunk)
                            if copied > MAX_COMPRESS_SOURCE_BYTES or copied_total > MAX_COMPRESS_SOURCE_BYTES:
                                raise Conflict("archive.source_too_large", "内容过大，暂不支持在库内压缩")
                            await asyncio.to_thread(target_stream.write, chunk)
            archive_size, digest = await _file_digest(output)
            if archive_size > remaining:
                raise Conflict("storage.full", "存储空间不足")
            output.seek(0)
            result = await _store_file(
                db, storage, user_id, target,
                folder_id=target_folder_id, folder_path=target.folder_path,
                display_name=archive_display, ext=archive_ext,
                mime_type="application/zip", source=output, size=archive_size,
                digest=digest, created_keys=created_keys,
            )
            await _commit_usage(db, user_id, archive_size, "archive_compress")
        await savepoint.commit()
        return result
    except BaseException:
        if savepoint.is_active:
            await savepoint.rollback()
        await _cleanup_created(storage, created_keys)
        raise


def _safe_archive_path(raw_name: str) -> str:
    if "\x00" in raw_name:
        raise Invalid("archive.unsafe_path", _CORRUPT_ARCHIVE)
    name = raw_name.replace("\\", "/")
    if name.startswith("/") or name.startswith("//") or _DRIVE_PREFIX.match(name):
        raise Invalid("archive.unsafe_path", _CORRUPT_ARCHIVE)
    parts = name.split("/")
    if any(part == ".." for part in parts):
        raise Invalid("archive.unsafe_path", _CORRUPT_ARCHIVE)
    normalized = [part for part in parts if part not in {"", "."}]
    result = "/".join(normalized)
    if result.startswith("/") or _DRIVE_PREFIX.match(result):
        raise Invalid("archive.unsafe_path", _CORRUPT_ARCHIVE)
    return result


async def _stage_archive(storage: StorageBackend, key: str) -> BinaryIO:
    stream = tempfile.TemporaryFile(mode="w+b")
    try:
        async for chunk in storage.iter_chunks(key, chunk_size=_CHUNK_SIZE):
            await asyncio.to_thread(stream.write, chunk)
        stream.seek(0)
        return stream
    except BaseException:
        stream.close()
        raise


def _zip_members(archive: zipfile.ZipFile) -> list[_ArchiveMember]:
    infos = archive.infolist()
    if len(infos) > MAX_ARCHIVE_ENTRIES:
        raise Conflict("archive.too_many_entries", "压缩包条目过多")
    members: list[_ArchiveMember] = []
    for info in infos:
        path = _safe_archive_path(info.filename)
        mode = info.external_attr >> 16
        is_symlink = stat.S_IFMT(mode) == stat.S_IFLNK
        if info.flag_bits & 0x1:
            raise Invalid("archive.encrypted", _UNSUPPORTED_FORMAT)
        if info.file_size < 0:
            raise Invalid("archive.invalid_size", _CORRUPT_ARCHIVE)
        members.append(_ArchiveMember(
            path=path,
            is_dir=info.is_dir(),
            size=0 if info.is_dir() or is_symlink else int(info.file_size),
            source=info,
            skipped=is_symlink,
        ))
    return members


def _tar_members(archive: tarfile.TarFile) -> list[_ArchiveMember]:
    infos = archive.getmembers()
    if len(infos) > MAX_ARCHIVE_ENTRIES:
        raise Conflict("archive.too_many_entries", "压缩包条目过多")
    members: list[_ArchiveMember] = []
    for info in infos:
        path = _safe_archive_path(info.name)
        skipped = not (info.isfile() or info.isdir())
        if info.size < 0:
            raise Invalid("archive.invalid_size", _CORRUPT_ARCHIVE)
        members.append(_ArchiveMember(
            path=path,
            is_dir=info.isdir(),
            size=int(info.size) if info.isfile() else 0,
            source=info,
            skipped=skipped,
        ))
    return members


def _single_archive_root(members: list[_ArchiveMember]) -> str | None:
    """返回归档唯一的顶层目录；它是包装层，应映射到用户指定的输出目录。"""
    visible_members = [member for member in members if member.path and not member.skipped]
    roots = {member.path.split("/", 1)[0] for member in visible_members}
    if len(roots) != 1:
        return None
    root_name = next(iter(roots))
    if any(member.path == root_name and not member.is_dir for member in visible_members):
        return None
    return root_name


def _validate_member_names(members: list[_ArchiveMember]) -> None:
    """拒绝无法表示为 File/Folder 行的超长归档路径，避免写入中途遇到 DB 限制。"""
    for member in members:
        if member.skipped or not member.path:
            continue
        segments = member.path.split("/")
        directory_segments = segments if member.is_dir else segments[:-1]
        if any(len(segment) > 200 for segment in directory_segments):
            raise Invalid("archive.invalid_name", _CORRUPT_ARCHIVE)
        if not member.is_dir:
            display_name, ext = _split_filename(segments[-1])
            if len(display_name) > 300 or len(ext) > 20:
                raise Invalid("archive.invalid_name", _CORRUPT_ARCHIVE)


async def _create_extracted_folder(
    db: AsyncSession,
    storage: StorageBackend,
    user_id,
    target: _Target,
    parent_id: int | None,
    parent_target_path: str,
    name: str,
    occupied_by_parent: dict[int | None, set[str]],
    created_folder_keys: list[str],
    created_folder_ids: list[int],
) -> tuple[int, str, str]:
    if parent_id not in occupied_by_parent:
        occupied_by_parent[parent_id] = await _occupied_names(db, user_id, target, parent_id)
    occupied = occupied_by_parent[parent_id]
    final_name = _unique_name(name, occupied, is_file=False)
    folder = Folder(
        user_id=user_id,
        project_id=target.project_id,
        workspace_directory_id=target.workspace_directory_id,
        parent_id=parent_id,
        name=final_name,
    )
    db.add(folder)
    await db.flush()
    created_folder_ids.append(folder.id)
    target_folder_path = f"{parent_target_path}/{final_name}" if parent_target_path else final_name
    folder_key = await _physical_folder_key(storage, user_id, target, target_folder_path)
    created_folder_keys.append(folder_key)
    await storage.ensure_folder(folder_key)
    return folder.id, final_name, target_folder_path


async def _ensure_archive_path_folders(
    db: AsyncSession,
    storage: StorageBackend,
    user_id,
    target: _Target,
    segments: list[str],
    occupied_by_parent: dict[int | None, set[str]],
    folder_by_archive_path: dict[str, int | None],
    folder_target_paths: dict[str, str],
    created_folder_keys: list[str],
    created_folder_ids: list[int],
) -> tuple[int | None, str, str]:
    parent_id = target.folder_id
    archive_parent = ""
    target_parent_path = target.folder_path
    for segment in segments:
        next_archive_path = f"{archive_parent}/{segment}" if archive_parent else segment
        existing_id = folder_by_archive_path.get(next_archive_path)
        if existing_id is None and next_archive_path in folder_by_archive_path:
            parent_id = None
        elif existing_id is not None:
            parent_id = existing_id
            target_parent_path = folder_target_paths[next_archive_path]
        else:
            parent_id, _, target_parent_path = await _create_extracted_folder(
                db, storage, user_id, target, parent_id, target_parent_path,
                segment, occupied_by_parent, created_folder_keys, created_folder_ids,
            )
            folder_by_archive_path[next_archive_path] = parent_id
            folder_target_paths[next_archive_path] = target_parent_path
        archive_parent = next_archive_path
    return parent_id, archive_parent, target_parent_path


async def _copy_archive_member(
    source: BinaryIO,
    destination: BinaryIO,
    *,
    maximum: int,
    declared_size: int,
) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    source.seek(0)
    while chunk := await asyncio.to_thread(source.read, _CHUNK_SIZE):
        size += len(chunk)
        if size > declared_size or size > maximum:
            raise Invalid("archive.invalid_size", _CORRUPT_ARCHIVE)
        digest.update(chunk)
        await asyncio.to_thread(destination.write, chunk)
    destination.seek(0)
    return size, digest.hexdigest()


async def extract_file(
    db: AsyncSession,
    user_id,
    file_id: int,
    *,
    folder_id: int | None = None,
    use_source_folder: bool = True,
    folder_name: str | None = None,
    format_hint: str | None = None,
    storage: StorageBackend | None = None,
) -> dict:
    """将 ZIP/TAR/TAR.GZ 展开到同空间目录，失败时回滚全部行与物理文件。"""
    storage = storage or get_storage()
    archive_file = await get_owned(db, File, file_id, user_id)
    if archive_file is None or archive_file.deleted_at is not None:
        raise NotFound("file.not_found", "压缩包不存在")
    extension = archive_file.display_name.lower()
    ext = archive_file.ext.lower()
    if not (extension.endswith((".zip", ".tar", ".tar.gz", ".tgz")) or ext in {"zip", "tar", "gz", "tgz"}):
        raise Invalid("archive.unsupported_format", _UNSUPPORTED_FORMAT)
    if format_hint and format_hint.lower().lstrip(".") not in {"zip", "tar", "tar.gz", "tgz"}:
        raise Invalid("archive.unsupported_format", _UNSUPPORTED_FORMAT)
    target_folder_id = archive_file.folder_id if use_source_folder and folder_id is None else folder_id
    target = await _target_for_file(db, user_id, archive_file, target_folder_id)
    remaining = await _quota_remaining(db, user_id)
    max_bytes = min(remaining, MAX_EXTRACT_BYTES)

    staged = await _stage_archive(storage, archive_file.storage_key)
    opened_zip: zipfile.ZipFile | None = None
    opened_tar: tarfile.TarFile | None = None
    try:
        try:
            if zipfile.is_zipfile(staged):
                staged.seek(0)
                opened_zip = zipfile.ZipFile(staged, "r")
                members = _zip_members(opened_zip)
                archive_kind = "zip"
            else:
                staged.seek(0)
                opened_tar = tarfile.open(fileobj=staged, mode="r:*")
                members = _tar_members(opened_tar)
                archive_kind = "tar"
        except Invalid:
            raise
        except (zipfile.BadZipFile, tarfile.TarError, EOFError, OSError, ValueError) as error:
            raise Invalid("archive.corrupt", _CORRUPT_ARCHIVE) from error
        _validate_member_names(members)
        if format_hint:
            expected = "zip" if format_hint.lower().lstrip(".") == "zip" else "tar"
            if expected != archive_kind:
                raise Invalid("archive.unsupported_format", _UNSUPPORTED_FORMAT)
        declared_total = sum(member.size for member in members if not member.skipped)
        if declared_total > max_bytes:
            raise Conflict("archive.expansion_too_large", "解压内容超过可用存储空间或安全上限")

        savepoint = await db.begin_nested()
        created_keys: list[str] = []
        created_folder_keys: list[str] = []
        created_file_ids: list[int] = []
        created_folder_ids: list[int] = []
        actual_total = 0
        skipped = sum(1 for member in members if member.skipped)
        occupied_by_parent: dict[int | None, set[str]] = {}
        folder_by_archive_path: dict[str, int | None] = {}
        folder_target_paths: dict[str, str] = {}
        extraction_target = target
        try:
            if folder_name is not None:
                safe_folder_name = folder_name.strip()
                if (
                    not safe_folder_name or safe_folder_name in {".", ".."}
                    or "\x00" in safe_folder_name or "/" in safe_folder_name
                    or "\\" in safe_folder_name or _DRIVE_PREFIX.match(safe_folder_name)
                    or len(safe_folder_name) > 200
                ):
                    raise Invalid("archive.invalid_name", "解压文件夹名称无效")
                root_id, _, root_path = await _create_extracted_folder(
                    db, storage, user_id, target, target.folder_id, target.folder_path,
                    safe_folder_name, occupied_by_parent, created_folder_keys,
                    created_folder_ids,
                )
                extraction_target = replace(target, folder_id=root_id, folder_path=root_path)
                # 归档只有一个顶层目录时，它只是包装层；映射到输出根目录，
                # 不再创建第二层目录，也不依赖归档名与用户填写名相同。
                archive_root = _single_archive_root(members)
                if archive_root is not None:
                    folder_by_archive_path[archive_root] = root_id
                    folder_target_paths[archive_root] = root_path
            for member in members:
                if not member.path:
                    continue
                segments = member.path.split("/")
                if member.is_dir:
                    await _ensure_archive_path_folders(
                        db, storage, user_id, extraction_target, segments,
                        occupied_by_parent, folder_by_archive_path,
                        folder_target_paths, created_folder_keys, created_folder_ids,
                    )
                    continue
                if member.skipped:
                    continue
                parent_segments = segments[:-1]
                parent_id, archive_parent, target_parent_path = await _ensure_archive_path_folders(
                    db, storage, user_id, extraction_target, parent_segments,
                    occupied_by_parent, folder_by_archive_path,
                    folder_target_paths, created_folder_keys, created_folder_ids,
                )
                leaf = segments[-1]
                if parent_id not in occupied_by_parent:
                    occupied_by_parent[parent_id] = await _occupied_names(db, user_id, target, parent_id)
                occupied = occupied_by_parent[parent_id]
                unique_leaf = _unique_name(leaf, occupied, is_file=True)
                display_name, file_ext = _split_filename(unique_leaf)
                if len(display_name) > 300 or len(file_ext) > 20:
                    raise Invalid("archive.invalid_name", _CORRUPT_ARCHIVE)
                if archive_kind == "zip":
                    assert opened_zip is not None
                    source = opened_zip.open(member.source, "r")
                else:
                    assert opened_tar is not None
                    source = opened_tar.extractfile(member.source)
                    if source is None:
                        raise Invalid("archive.corrupt", _CORRUPT_ARCHIVE)
                with source, tempfile.TemporaryFile(mode="w+b") as content:
                    try:
                        actual_size, digest = await _copy_archive_member(
                            source, content, maximum=max_bytes - actual_total,
                            declared_size=member.size,
                        )
                    except (zipfile.BadZipFile, tarfile.TarError, EOFError) as error:
                        raise Invalid("archive.corrupt", _CORRUPT_ARCHIVE) from error
                    except NotImplementedError as error:
                        raise Invalid("archive.unsupported_format", _UNSUPPORTED_FORMAT) from error
                    actual_total += actual_size
                    if actual_total > max_bytes:
                        raise Conflict("archive.expansion_too_large", "解压内容超过可用存储空间或安全上限")
                    before_count = len(created_keys)
                    created = await _store_file(
                        db, storage, user_id, extraction_target,
                        folder_id=parent_id, folder_path=target_parent_path,
                        display_name=display_name, ext=file_ext,
                        mime_type=mimetypes.guess_type(unique_leaf)[0] or "application/octet-stream",
                        source=content,
                        size=actual_size, digest=digest, created_keys=created_keys,
                    )
                    if len(created_keys) > before_count:
                        created_file_ids.append(created.id)
                    # 存储 key 可能因孤儿物理对象冲突再次改名；加入实际名称避免后续覆盖。
                    occupied.add(_entry_name(created))
            await _commit_usage(db, user_id, actual_total, "archive_extract")
            await savepoint.commit()
        except BaseException:
            if savepoint.is_active:
                await savepoint.rollback()
            await _cleanup_created(storage, created_keys, created_folder_keys)
            raise

        return {
            "created_count": len(created_file_ids) + len(created_folder_keys),
            "file_count": len(created_file_ids),
            "folder_count": len(created_folder_keys),
            "skipped_count": skipped,
            "rejected_count": 0,
            "file_ids": created_file_ids,
            "folder_ids": created_folder_ids,
        }
    finally:
        if opened_zip is not None:
            opened_zip.close()
        if opened_tar is not None:
            opened_tar.close()
        staged.close()


__all__ = [
    "MAX_COMPRESS_SOURCE_BYTES", "MAX_EXTRACT_BYTES", "MAX_ARCHIVE_ENTRIES",
    "compress_files", "extract_file",
]
