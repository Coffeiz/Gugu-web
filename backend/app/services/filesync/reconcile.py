"""本地文件发现与 DB 投影。

Phase 2 先采用可重试的增量扫描作为 watcher 的安全落点：扫描结果进入同一
journal，后续可把 OS watcher 只作为候选事件来源，而不让 watcher 直接改 DB。
"""
from __future__ import annotations

import hashlib
import mimetypes
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.models import File, FileSyncBinding, FileSyncJournal, Folder, Project, User
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
from app.services.workspaces import resolve_workspace_root, workspace_shell_supported
from app.core.config import get_settings
from app.services.filesync.snapshots import save_snapshot


@dataclass(frozen=True)
class SyncSummary:
    scanned: int = 0
    created: int = 0
    updated: int = 0
    moved: int = 0
    deleted: int = 0
    rejected: int = 0
    conflicts: int = 0
    journal_ids: tuple[int, ...] = ()
    entity_ids: tuple[int, ...] = ()


@dataclass(frozen=True)
class FileChangeCandidate:
    relative_path: str
    operation: str
    fingerprint: str | None = None


class LocalDirectoryWatcher:
    """轻量候选发现器；不直接写 DB，丢事件由 reconcile 全量补偿。"""

    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        self._snapshot: dict[str, tuple[int, int]] | None = None

    def poll(self) -> list[FileChangeCandidate]:
        current: dict[str, tuple[int, int]] = {}
        candidates: list[FileChangeCandidate] = []
        for path in self.root.rglob("*"):
            if not path.is_file() or path.is_symlink():
                continue
            try:
                relative = validate_sync_path(self.root, path.relative_to(self.root).as_posix())
                stat = path.stat()
            except (OSError, ValueError):
                continue
            key = relative.relative_to(self.root).as_posix()
            current[key] = (stat.st_size, stat.st_mtime_ns)
        previous = self._snapshot
        self._snapshot = current
        if previous is None:
            return []
        for key in sorted(current.keys() - previous.keys()):
            candidates.append(FileChangeCandidate(key, "create"))
        for key in sorted(previous.keys() - current.keys()):
            candidates.append(FileChangeCandidate(key, "delete"))
        for key in sorted(current.keys() & previous.keys()):
            if current[key] != previous[key]:
                candidates.append(FileChangeCandidate(key, "update"))
        return candidates


def _fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
) -> int | None:
    parent_id = None
    for name in folder_names:
        query = select(Folder).where(
            Folder.user_id == user_id, Folder.project_id == project_id,
            Folder.parent_id == parent_id, Folder.name == name,
            Folder.deleted_at.is_(None),
        )
        folder = (await db.execute(query)).scalar_one_or_none()
        if folder is None:
            folder = Folder(
                user_id=user_id, project_id=project_id, parent_id=parent_id,
                name=name,
            )
            db.add(folder)
            await db.flush()
        parent_id = folder.id
    return parent_id


async def _classify_path(db: AsyncSession, user_id, path: Path, user_root: Path):
    """把 canonical 本地路径解析为 File 的归属字段。"""
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
    return space, project_id, folder_id, display_name, ext


async def reconcile_local_directory(
    db: AsyncSession,
    user_id,
    *,
    root: Path | None = None,
    workspace_id: int | None = None,
    source: str = FileSyncSource.LOCAL_DIRECTORY,
    allow_delete: bool = True,
    blocked_paths: set[str] | None = None,
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

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    quota_settings = getattr(settings, "quota", None)
    quota_limit = int(
        (user.storage_limit_bytes if user else None)
        or getattr(quota_settings, "default_storage_limit_bytes", 2**63 - 1)
    )
    physical_bytes = sum(item.stat().st_size for item in root.rglob("*") if item.is_file() and not item.is_symlink())
    if physical_bytes > quota_limit:
        return SyncSummary(rejected=1)

    binding = await _binding_for(
        db, user_id, source=str(source), workspace_id=workspace_id, root=root,
    )
    physical = []
    rejected = 0
    for item in root.rglob("*"):
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
        latest_by_path.setdefault(item.relative_path, item)
    missing = {key: row for key, row in known.items() if key not in physical_by_key}
    orphans = {key: path for key, path in physical_by_key.items() if key not in known}
    journal_ids: list[int] = []
    entity_ids: list[int] = []
    created = updated = moved = deleted = 0
    blocked_paths = blocked_paths or set()

    # 空目录没有 File 行可触发投影，也要补齐 Folder，便于 UI 与后续 Shell
    # 写入继续使用同一归属链；仅处理 canonical 个人/项目目录，跳过年月和项目容器。
    for directory in sorted((item for item in root.rglob("*") if item.is_dir() and not item.is_symlink()), key=lambda item: len(item.parts)):
        parts = directory.relative_to(user_root).parts
        if parts and parts[0] == "个人文件" and len(parts) > 1:
            await _folder_for_path(db, user_id, space="personal", project_id=None, folder_names=list(parts[1:]))
        elif parts and parts[0] == "项目文件" and len(parts) > 4:
            try:
                project_id = int(parts[3].rsplit("#", 1)[1].strip())
            except ValueError:
                continue
            folder_names = list(parts[4:])
            if folder_names:
                await _folder_for_path(db, user_id, space="project", project_id=project_id, folder_names=folder_names)

    missing_fingerprints: dict[str, list[tuple[File, str]]] = {}
    for row in missing.values():
        old_relative = row.storage_key.removeprefix(scope_prefix)
        old_journal = latest_by_path.get(old_relative)
        if old_journal and old_journal.observed_fingerprint:
            missing_fingerprints.setdefault(str(row.size_bytes), []).append(
                (row, old_journal.observed_fingerprint)
            )

    consumed: set[str] = set()
    for key, path in orphans.items():
        relative = path.relative_to(root).as_posix()
        if relative in blocked_paths:
            continue
        try:
            validate_sync_path(root, relative)
            space, project_id, folder_id, display_name, ext = await _classify_path(
                db, user_id, path, user_root,
            )
            observed = _fingerprint(path)
        except (OSError, ValueError):
            rejected += 1
            continue
        candidate = None
        for row, digest in missing_fingerprints.get(str(path.stat().st_size), []):
            if row.id not in consumed and digest == observed:
                candidate = row
                consumed.add(row.id)
                break
        if candidate is not None:
            old_key = candidate.storage_key
            candidate.storage_key = key
            candidate.display_name = display_name
            candidate.ext = ext
            candidate.space = space
            candidate.project_id = project_id
            candidate.folder_id = folder_id
            candidate.size_bytes = path.stat().st_size
            candidate.size = str(path.stat().st_size)
            candidate.version = int(candidate.version or 1) + 1
            candidate.updated_at = now_utc()
            operation = FileSyncOperation.MOVE
            moved += 1
            entity_ids.append(candidate.id)
            old_journal = latest_by_path.get(old_key.removeprefix(scope_prefix))
            baseline = old_journal.observed_fingerprint if old_journal else None
        else:
            stat = path.stat()
            candidate = File(
                user_id=user_id, display_name=display_name, ext=ext, space=space,
                project_id=project_id, folder_id=folder_id, stage_name="",
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
        observed = _fingerprint(path)
        previous = latest_by_path.get(relative)
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
            latest_by_path[relative] = previous
            journal_ids.append(previous.id)
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
            try:
                save_snapshot(user_id, binding.id, relative, path)
            except OSError:
                rejected += 1

    for key, row in missing.items():
        if row.id in consumed:
            continue
        relative = key.removeprefix(scope_prefix)
        if relative in blocked_paths or not allow_delete:
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
        entity_ids=tuple(entity_ids),
    )
