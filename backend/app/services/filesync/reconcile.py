"""本地文件/文件夹发现与 DB 投影。

watcher 只负责发现候选，所有改变都在这里经过路径、归属、配额和稳定性校验，
再以同一事务投影到 File/Folder 与 journal。这样外部复制、Shell 写入和 UI 文件
操作不会各自维护一套同步逻辑。
"""
from __future__ import annotations

import hashlib
import mimetypes
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.models import File, FileSyncBinding, FileSyncJournal, Folder, Project, User, WorkspaceDirectory
from app.core.ownership import get_owned
from app.services.filesync.protocol import (
    FILE_SYNC_PROTOCOL_VERSION,
    FileSyncOperation,
    FileSyncSource,
    FileSyncStatus,
    create_binding,
    build_idempotency_key,
    is_file_sync_enabled,
    record_change,
    validate_sync_path,
)
from app.services.workspaces import get_workspace, resolve_workspace_root, workspace_shell_supported
from app.core.config import get_settings
from app.services.filesync.snapshots import save_snapshot
from app.services.storage.folders import folder_dir_key
from app.services.files.previews import delete_thumb_cache


@dataclass(frozen=True)
class SyncSummary:
    scanned: int = 0
    created: int = 0
    updated: int = 0
    moved: int = 0
    deleted: int = 0
    rejected: int = 0
    conflicts: int = 0
    folders_created: int = 0
    folders_updated: int = 0
    folders_deleted: int = 0
    journal_ids: tuple[int, ...] = ()
    entity_ids: tuple[int, ...] = ()


def _fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stable_fingerprint(path: Path) -> str:
    """只接受一次完整、稳定的读取，避免把正在复制的文件写成半成品。"""
    before = path.stat()
    digest = _fingerprint(path)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("文件仍在写入")
    return digest


def _root_fingerprint(root: Path) -> str:
    return hashlib.sha256(str(root.resolve()).encode("utf-8")).hexdigest()


def _file_name(path: Path) -> tuple[str, str]:
    if path.suffix:
        return path.stem, path.suffix[1:].lower()
    return path.name, ""


def _safe_storage_key(storage_root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(storage_root.resolve()).as_posix()
    except ValueError as exc:
        raise ValueError("同步文件不在本地存储根内") from exc


def _is_sync_temporary(path: Path) -> bool:
    return path.name.startswith(".gugu-sync-") or path.name.endswith((".gugu-part", ".gugu-tmp"))


async def _binding_for(
    db: AsyncSession,
    user_id,
    *,
    source: str,
    workspace_id: int | None,
    root: Path,
) -> FileSyncBinding:
    existing = await db.scalar(select(FileSyncBinding).where(
        FileSyncBinding.user_id == user_id,
        FileSyncBinding.workspace_id == workspace_id,
        FileSyncBinding.source == source,
    ))
    if existing is not None:
        if existing.root_fingerprint != _root_fingerprint(root):
            existing.root_fingerprint = _root_fingerprint(root)
            existing.protocol_version = FILE_SYNC_PROTOCOL_VERSION
        return existing
    return await create_binding(
        db, user_id=user_id, source=source,
        workspace_id=workspace_id, root_fingerprint=_root_fingerprint(root),
        root_path=".",
    )


async def _folder_for_path(
    db: AsyncSession,
    user_id,
    *,
    space: str,
    project_id: int | None,
    folder_names: list[str],
    workspace_directory_id: int | None = None,
) -> int | None:
    folder_id, _ = await _ensure_folder_path(
        db, user_id, space=space, project_id=project_id, folder_names=folder_names,
        workspace_directory_id=workspace_directory_id,
    )
    return folder_id


async def _ensure_folder_path(
    db: AsyncSession,
    user_id,
    *,
    space: str,
    project_id: int | None,
    folder_names: list[str],
    workspace_directory_id: int | None = None,
) -> tuple[int | None, bool]:
    # workspace 空间按 workspace_directory_id 隔离同名链；None 等价 IS NULL，
    # 与既有个人/项目行为一致（它们永不携带 workspace_directory_id）。
    parent_id = None
    created = False
    for name in folder_names:
        query = select(Folder).where(
            Folder.user_id == user_id, Folder.project_id == project_id,
            Folder.parent_id == parent_id, Folder.name == name,
            Folder.workspace_directory_id == workspace_directory_id,
            Folder.deleted_at.is_(None),
        )
        folder = (await db.execute(query)).scalar_one_or_none()
        if folder is None:
            folder = Folder(
                user_id=user_id, project_id=project_id, parent_id=parent_id,
                workspace_directory_id=workspace_directory_id,
                name=name,
            )
            db.add(folder)
            await db.flush()
            created = True
        parent_id = folder.id
    return parent_id, created


def _directory_fingerprint(directory: Path) -> str:
    """用目录结构生成稳定指纹，不把文件正文重复写入文件夹日志。"""
    digest = hashlib.sha256()
    for item in sorted(directory.rglob("*"), key=lambda path: path.relative_to(directory).as_posix()):
        if item.is_symlink() or not (item.is_file() or item.is_dir()):
            continue
        relative = item.relative_to(directory).as_posix()
        marker = "d" if item.is_dir() else "f"
        digest.update(f"{marker}:{relative}\n".encode("utf-8"))
    return digest.hexdigest()


def _parse_directory_path(path: Path, user_root: Path) -> tuple[str, int | None, list[str]] | None:
    parts = path.relative_to(user_root).parts
    if not parts:
        return None
    if parts[0] == "个人文件" and len(parts) > 1:
        return "personal", None, list(parts[1:])
    if parts[0] == "项目文件" and len(parts) > 3:
        project_dir = parts[3]
        if "#" not in project_dir:
            return None
        try:
            project_id = int(project_dir.rsplit("#", 1)[1].strip())
        except ValueError:
            return None
        folder_names = list(parts[4:])
        return ("project", project_id, folder_names) if folder_names else None
    return None


async def _classify_path(
    db: AsyncSession,
    user_id,
    path: Path,
    user_root: Path,
    *,
    workspace_directory_id: int | None = None,
    base: Path | None = None,
):
    """把 canonical 本地路径解析为 File 的归属字段。

    directory 型工作区绑定例外：物理根就是工作区目录本身（workspace/、
    workspace-<id>/），不在 canonical 前缀树下，按 base（绑定根）相对解析为
    space=workspace。
    """
    if workspace_directory_id is not None:
        parts = path.relative_to(base or user_root).parts
        if not parts:
            raise ValueError("同步文件缺少空间路径")
        filename = parts[-1]
        space = "workspace"
        project_id = None
        folder_names = list(parts[:-1])
        display_name, ext = _file_name(Path(filename))
        folder_id = await _folder_for_path(
            db, user_id, space=space, project_id=project_id, folder_names=folder_names,
            workspace_directory_id=workspace_directory_id,
        )
        return space, project_id, folder_id, display_name, ext, workspace_directory_id
    parts = path.relative_to(user_root).parts
    if len(parts) < 2:
        raise ValueError("同步文件缺少空间路径")
    space_root, *rest = parts
    filename = rest.pop()
    if space_root == "个人文件":
        project_id = None
        space = "personal"
        folder_names = list(rest)
    elif space_root == "项目文件" and len(rest) >= 3:
        project_dir = rest[2]
        if "#" not in project_dir:
            raise ValueError("项目路径缺少项目标识")
        try:
            project_id = int(project_dir.rsplit("#", 1)[1].strip())
        except ValueError as exc:
            raise ValueError("项目路径标识无效") from exc
        if await get_owned(db, Project, project_id, user_id) is None:
            raise ValueError("项目不属于当前用户")
        space = "project"
        folder_names = list(rest[3:])
    else:
        raise ValueError("同步只支持个人文件和项目文件")
    display_name, ext = _file_name(Path(filename))
    folder_id = await _folder_for_path(
        db, user_id, space=space, project_id=project_id, folder_names=folder_names,
    )
    return space, project_id, folder_id, display_name, ext, None


async def reconcile_local_directory(
    db: AsyncSession,
    user_id,
    *,
    root: Path | None = None,
    workspace_id: int | None = None,
    source: str = FileSyncSource.LOCAL_DIRECTORY,
    allow_delete: bool = True,
    blocked_paths: set[str] | None = None,
    binding: FileSyncBinding | None = None,
    dry_run: bool = False,
) -> SyncSummary:
    """扫描一个已归属的本地根并将物理变化投影为 File/Folder。

    ``root`` 只能是当前用户的 local storage 子目录；传 workspace_id 时会重新
    通过 ownership 解析，不能相信调用方传入的路径。OSS 永远返回拒绝，不做
    materialize/cache，也不把独立 Shell 目录伪装成文件库。
    """
    if not is_file_sync_enabled():
        return SyncSummary(rejected=1)
    if not workspace_shell_supported():
        return SyncSummary(rejected=1)
    settings = get_settings()
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    user_root = (storage_root / str(user_id)).resolve()
    if workspace_id is not None:
        root = await resolve_workspace_root(db, user_id, workspace_id)
        if root is None:
            return SyncSummary(rejected=1)
    else:
        root = root.expanduser().resolve() if root is not None else user_root
    try:
        root.relative_to(user_root)
    except ValueError:
        return SyncSummary(rejected=1)
    if not root.exists() or not root.is_dir():
        return SyncSummary(rejected=1)

    # directory 型工作区（WorkspaceDirectory）的绑定根就是工作区目录本身，
    # 不在 canonical 个人/项目前缀树下；文件与目录都按 space=workspace 投影，
    # 并挂到对应 workspace_directory_id，否则整棵树会被当作不支持路径拒绝。
    workspace_directory_id: int | None = None
    if workspace_id is not None:
        ws_row = await get_workspace(db, user_id, workspace_id)
        if ws_row is not None and ws_row.kind == "directory" and ws_row.directory_id is not None:
            directory_row = await get_owned(db, WorkspaceDirectory, ws_row.directory_id, user_id)
            if directory_row is not None and directory_row.deleted_at is None:
                workspace_directory_id = directory_row.id

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    quota_settings = getattr(settings, "quota", None)
    quota_limit = int(
        (user.storage_limit_bytes if user else None)
        or getattr(quota_settings, "default_storage_limit_bytes", 2**63 - 1)
    )
    # 配额属于用户存储总量，不属于某一个 workspace；否则用户可以通过
    # 创建多个 workspace 分摊检查，最终突破统一存储上限。
    physical_bytes = sum(
        item.stat().st_size
        for item in user_root.rglob("*")
        if item.is_file() and not item.is_symlink()
    )
    if physical_bytes > quota_limit:
        return SyncSummary(rejected=1)

    if binding is None:
        binding = await _binding_for(
            db, user_id, source=str(source), workspace_id=workspace_id, root=root,
        )
    physical = []
    physical_folders: dict[str, Path] = {}
    rejected = 0
    for item in root.rglob("*"):
        if _is_sync_temporary(item):
            continue
        if item.is_dir() and not item.is_symlink():
            try:
                validate_sync_path(root, item.relative_to(root).as_posix())
                physical_folders[item.relative_to(root).as_posix()] = item
            except (OSError, ValueError):
                rejected += 1
            continue
        if not item.is_file():
            continue
        if item.is_symlink():
            rejected += 1
            continue
        try:
            validate_sync_path(root, item.relative_to(root).as_posix())
            _safe_storage_key(storage_root, item)
        except (OSError, ValueError):
            rejected += 1
            continue
        physical.append(item)
    physical_by_key = {_safe_storage_key(storage_root, item): item for item in physical}
    scope_prefix = root.relative_to(storage_root).as_posix().rstrip("/") + "/"
    rows = (await db.scalars(select(File).where(
        File.user_id == user_id, File.deleted_at.is_(None),
        File.storage_key.like(f"{scope_prefix}%"),
    ))).all()
    known = {row.storage_key: row for row in rows}
    journal_history = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
        FileSyncJournal.status == FileSyncStatus.SYNCED,
    ).order_by(FileSyncJournal.id.desc()))).all()
    latest_by_path = {}
    for item in journal_history:
        latest_by_path.setdefault((item.object_type or "file", item.relative_path), item)
    missing = {key: row for key, row in known.items() if key not in physical_by_key}
    orphans = {key: path for key, path in physical_by_key.items() if key not in known}
    journal_ids: list[int] = []
    entity_ids: list[int] = []
    created = updated = moved = deleted = 0
    folders_created = folders_updated = folders_deleted = 0
    blocked_paths = blocked_paths or set()

    # 空目录没有 File 行可触发投影，也要补齐 Folder，便于 UI 与后续 Shell
    # 写入继续使用同一归属链；仅处理 canonical 个人/项目目录，跳过年月和项目容器。
    # directory 型工作区例外：根下每一层都是工作区文件夹，直接按相对链补齐。
    for relative, directory in sorted(physical_folders.items(), key=lambda item: (item[0].count("/"), item[0])):
        if workspace_directory_id is not None:
            space, project_id, folder_names = "workspace", None, list(directory.relative_to(root).parts)
        else:
            parsed = _parse_directory_path(directory, user_root)
            if parsed is None:
                continue
            space, project_id, folder_names = parsed
        if project_id is not None and await get_owned(db, Project, project_id, user_id) is None:
            rejected += 1
            continue
        folder_id, was_created = await _ensure_folder_path(
            db, user_id, space=space, project_id=project_id, folder_names=folder_names,
            workspace_directory_id=workspace_directory_id,
        )
        if folder_id is None:
            continue
        observed = _directory_fingerprint(directory)
        previous = latest_by_path.get(("folder", relative))
        if previous is None:
            operation = FileSyncOperation.CREATE if was_created else FileSyncOperation.BASELINE
        elif previous.observed_fingerprint != observed:
            operation = FileSyncOperation.UPDATE
        else:
            continue
        journal = await record_change(
            db, binding=binding, user_id=user_id, source=str(source), operation=operation,
            object_type="folder", relative_path=relative,
            idempotency_key=build_idempotency_key(
                source=str(source), operation=str(operation), object_type="folder",
                relative_path=relative, fingerprint=observed,
            ), observed_fingerprint=observed, status=FileSyncStatus.SYNCED,
        )
        journal_ids.append(journal.id)
        latest_by_path[("folder", relative)] = journal
        entity_ids.append(folder_id)
        if operation == FileSyncOperation.CREATE:
            folders_created += 1
        elif operation == FileSyncOperation.UPDATE:
            folders_updated += 1

    # 物理目录被改名/移动/删除后，旧 Folder 行不能继续作为 UI 的活动目录。
    # 只处理当前绑定根下的路径，避免一个子目录绑定误删用户其他空间的目录树。
    active_folders = (await db.scalars(select(Folder).where(
        Folder.user_id == user_id, Folder.deleted_at.is_(None),
    ))).all()
    for folder in active_folders:
        folder_key = await folder_dir_key(db, user_id, folder)
        if not folder_key:
            continue
        try:
            relative = (storage_root / folder_key).resolve().relative_to(root).as_posix()
        except ValueError:
            continue
        if relative == ".":
            # workspace-folder 绑定的根目录本身就是绑定锚点，不属于本次根内的
            # 子目录清单；只清理它下面实际消失的 Folder。
            continue
        if relative in physical_folders:
            continue
        folder.deleted_at = now_utc()
        folder.version = int(folder.version or 1) + 1
        folder.updated_at = now_utc()
        folders_deleted += 1
        entity_ids.append(folder.id)
        previous = latest_by_path.get(("folder", relative))
        journal = await record_change(
            db, binding=binding, user_id=user_id, source=str(source),
            operation=FileSyncOperation.DELETE, object_type="folder", relative_path=relative,
            idempotency_key=build_idempotency_key(
                source=str(source), operation=str(FileSyncOperation.DELETE), object_type="folder",
                relative_path=relative, fingerprint=str(folder.version),
            ), baseline_fingerprint=previous.observed_fingerprint if previous else None,
            status=FileSyncStatus.SYNCED,
        )
        journal_ids.append(journal.id)

    missing_fingerprints: dict[str, list[tuple[File, str]]] = {}
    for row in missing.values():
        old_relative = row.storage_key.removeprefix(scope_prefix)
        old_journal = latest_by_path.get(("file", old_relative))
        if old_journal and old_journal.observed_fingerprint:
            missing_fingerprints.setdefault(str(row.size_bytes), []).append(
                (row, old_journal.observed_fingerprint)
            )

    consumed: set[str] = set()
    ambiguous_missing_keys: set[str] = set()
    for key, path in orphans.items():
        relative = path.relative_to(root).as_posix()
        if relative in blocked_paths:
            continue
        try:
            validate_sync_path(root, relative)
            space, project_id, folder_id, display_name, ext, file_ws_dir_id = await _classify_path(
                db, user_id, path, user_root,
                workspace_directory_id=workspace_directory_id,
                base=root,
            )
            observed = _stable_fingerprint(path)
        except (OSError, ValueError):
            rejected += 1
            continue
        candidates = [
            (row, digest)
            for row, digest in missing_fingerprints.get(str(path.stat().st_size), [])
            if row.id not in consumed and digest == observed
        ]
        # 相同 size/hash 不能证明两个文件的身份。歧义时保留物理文件和 DB
        # 记录，不把 File.id 猜着交换，也不在本轮把原记录软删除。
        candidate = candidates[0][0] if len(candidates) == 1 else None
        if len(candidates) > 1:
            for row, _digest in candidates:
                ambiguous_missing_keys.add(row.storage_key)
            rejected += 1
            continue
        if candidate is not None:
            consumed.add(candidate.id)
        if candidate is not None:
            old_key = candidate.storage_key
            candidate.storage_key = key
            candidate.display_name = display_name
            candidate.ext = ext
            candidate.space = space
            candidate.project_id = project_id
            candidate.folder_id = folder_id
            candidate.workspace_directory_id = file_ws_dir_id
            candidate.size_bytes = path.stat().st_size
            candidate.size = str(path.stat().st_size)
            candidate.version = int(candidate.version or 1) + 1
            candidate.updated_at = now_utc()
            operation = FileSyncOperation.MOVE
            moved += 1
            entity_ids.append(candidate.id)
            old_journal = latest_by_path.get(("file", old_key.removeprefix(scope_prefix)))
            baseline = old_journal.observed_fingerprint if old_journal else None
        else:
            stat = path.stat()
            candidate = File(
                user_id=user_id, display_name=display_name, ext=ext, space=space,
                project_id=project_id, folder_id=folder_id,
                workspace_directory_id=file_ws_dir_id, stage_name="",
                storage_key=key, storage_backend="local", size=str(stat.st_size),
                size_bytes=stat.st_size, mime_type=mimetypes.guess_type(path.name)[0],
            )
            db.add(candidate)
            await db.flush()
            operation = FileSyncOperation.CREATE
            created += 1
            entity_ids.append(candidate.id)
            baseline = None
        journal = await record_change(
            db, binding=binding, user_id=user_id, source=str(source), operation=operation,
            relative_path=relative,
            idempotency_key=build_idempotency_key(
                source=str(source), operation=str(operation),
                relative_path=relative, fingerprint=observed,
            ),
            baseline_fingerprint=baseline, observed_fingerprint=observed,
            status=FileSyncStatus.SYNCED,
        )
        journal_ids.append(journal.id)
        if not dry_run:
            try:
                save_snapshot(user_id, binding.id, relative, path)
            except OSError:
                rejected += 1

    for key, row in known.items():
        if row.id in consumed or key not in physical_by_key:
            continue
        path = physical_by_key[key]
        relative = path.relative_to(root).as_posix()
        if relative in blocked_paths:
            continue
        try:
            observed = _stable_fingerprint(path)
        except (OSError, ValueError):
            rejected += 1
            continue
        previous = latest_by_path.get(("file", relative))
        if previous is None:
            previous = await record_change(
                db, binding=binding, user_id=user_id, source=str(source),
                operation=FileSyncOperation.BASELINE,
                relative_path=relative,
                idempotency_key=build_idempotency_key(
                    source=str(source), operation=FileSyncOperation.BASELINE,
                    relative_path=relative, fingerprint=observed,
                ),
                observed_fingerprint=observed, status=FileSyncStatus.SYNCED,
            )
            latest_by_path[("file", relative)] = previous
            journal_ids.append(previous.id)
            if not dry_run:
                try:
                    save_snapshot(user_id, binding.id, relative, path)
                except OSError:
                    rejected += 1
        if row.size_bytes != path.stat().st_size or (
            previous is not None and previous.observed_fingerprint != observed
        ):
            row.size_bytes = path.stat().st_size
            row.size = str(path.stat().st_size)
            row.version = int(row.version or 1) + 1
            row.updated_at = now_utc()
            # 文件正文变了，旧缩略图即使仍在磁盘也不能继续返回。
            if not dry_run:
                delete_thumb_cache(row.id, storage_root)
            updated += 1
            entity_ids.append(row.id)
            journal = await record_change(
                db, binding=binding, user_id=user_id, source=str(source),
                operation=FileSyncOperation.UPDATE,
                relative_path=relative,
                idempotency_key=build_idempotency_key(
                    source=str(source), operation=FileSyncOperation.UPDATE,
                    relative_path=relative, fingerprint=observed,
                ),
                observed_fingerprint=observed, status=FileSyncStatus.SYNCED,
            )
            journal_ids.append(journal.id)
            if not dry_run:
                try:
                    save_snapshot(user_id, binding.id, relative, path)
                except OSError:
                    rejected += 1

    for key, row in missing.items():
        if row.id in consumed:
            continue
        relative = key.removeprefix(scope_prefix)
        # 存量脏 storage_key（如用户前缀后跟双斜杠）去前缀后仍是绝对路径，
        # 不能让它抛异常中断整轮投影；当作 rejected 跳过，等数据修复后再同步。
        if (
            not relative or relative.startswith("/")
            or key in ambiguous_missing_keys or relative in blocked_paths
            or not allow_delete
        ):
            rejected += 1
            continue
        row.deleted_at = now_utc()
        row.version = int(row.version or 1) + 1
        deleted += 1
        entity_ids.append(row.id)
        journal = await record_change(
            db, binding=binding, user_id=user_id, source=str(source),
            operation=FileSyncOperation.DELETE,
            relative_path=relative,
            idempotency_key=build_idempotency_key(
                source=str(source), operation=FileSyncOperation.DELETE,
                relative_path=relative, fingerprint=str(row.version),
            ),
            baseline_fingerprint=None, status=FileSyncStatus.SYNCED,
        )
        journal_ids.append(journal.id)
    binding.last_reconciled_at = now_utc()
    await db.flush()
    return SyncSummary(
        scanned=len(physical), created=created, updated=updated, moved=moved,
        deleted=deleted, rejected=rejected, journal_ids=tuple(journal_ids),
        entity_ids=tuple(entity_ids), folders_created=folders_created,
        folders_updated=folders_updated, folders_deleted=folders_deleted,
    )
