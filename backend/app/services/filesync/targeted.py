"""按 sidecar 精确事件做单点投影。

TS sidecar 的事件自带 relative_path/operation/object_type；本模块把一小批
路径事件直接投影为 File/Folder 与 journal，不再对整个绑定根做全树对账。
任何路径级失败按 rejected 记录（与整树 reconcile 的处置一致）；只有基础
设施级异常才向上抛给 watcher 回退整树补偿。
"""
from __future__ import annotations

import logging
import mimetypes
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

from app.core.config import get_settings
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import File, FileSyncBinding, FileSyncJournal, Folder, Project, User
from app.services.files.previews import delete_thumb_cache
from app.services.filesync.protocol import (
    FileSyncOperation,
    FileSyncSource,
    FileSyncStatus,
    build_idempotency_key,
    is_file_sync_enabled,
    record_change,
    validate_sync_path,
)
from app.services.filesync.reconcile import (
    SyncSummary,
    _directory_fingerprint,
    _classify_path,
    _find_folder_path,
    _is_sync_temporary,
    _parse_directory_path,
    _safe_storage_key,
    _stable_fingerprint,
    _workspace_directory_id_for,
)
from app.services.filesync.snapshots import save_snapshot
from app.services.filesync.statcache import StatCache
from app.services.workspaces import workspace_shell_supported


@dataclass
class PathEventBatch:
    """同一绑定在相邻两次 drain 之间累积的路径事件；changed/deleted 互斥收敛。"""

    changed: set[str] = field(default_factory=set)
    deleted: set[str] = field(default_factory=set)
    folders_created: set[str] = field(default_factory=set)
    folders_deleted: set[str] = field(default_factory=set)

    def empty(self) -> bool:
        return not (self.changed or self.deleted or self.folders_created or self.folders_deleted)

    def all_paths(self) -> set[str]:
        return self.changed | self.deleted | self.folders_created | self.folders_deleted


async def _quota_limit(db: AsyncSession, user_id) -> int:
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    quota_settings = getattr(get_settings(), "quota", None)
    return int(
        (user.storage_limit_bytes if user else None)
        or getattr(quota_settings, "default_storage_limit_bytes", 2**63 - 1)
    )


async def _live_storage_bytes(db: AsyncSession, user_id) -> int:
    total = await db.scalar(select(func.coalesce(func.sum(File.size_bytes), 0)).where(
        File.user_id == user_id, File.deleted_at.is_(None),
    ))
    return int(total or 0)


def _scope_prefix(storage_root: Path, root: Path) -> str:
    return root.relative_to(storage_root).as_posix().rstrip("/") + "/"


async def _latest_journals(
    db: AsyncSession, binding_id: int, paths: set[str],
) -> dict[tuple[str, str], FileSyncJournal]:
    journals = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding_id,
        FileSyncJournal.status == FileSyncStatus.SYNCED,
        FileSyncJournal.relative_path.in_(paths),
    ).order_by(FileSyncJournal.id.desc()))).all()
    latest: dict[tuple[str, str], FileSyncJournal] = {}
    for item in journals:
        latest.setdefault((item.object_type or "file", item.relative_path), item)
    return latest


async def _find_move_source(
    db: AsyncSession, binding: FileSyncBinding, scope_prefix: str,
    relative: str, observed: str, root: Path,
) -> File | None:
    """同指纹且原路径已消失 → 视为移动，复用原 File 行而不是删旧建新。"""
    journals = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
        FileSyncJournal.status == FileSyncStatus.SYNCED,
        FileSyncJournal.object_type == "file",
        FileSyncJournal.observed_fingerprint == observed,
        FileSyncJournal.relative_path != relative,
    ).order_by(FileSyncJournal.id.desc()).limit(10))).all()
    for journal in journals:
        old_key = scope_prefix + journal.relative_path
        row = (await db.execute(select(File).where(
            File.user_id == binding.user_id, File.storage_key == old_key,
            File.deleted_at.is_(None),
        ))).scalar_one_or_none()
        if row is None:
            continue
        if (root / journal.relative_path).exists():
            continue
        return row
    return None


async def _project_changed_file(
    db: AsyncSession,
    user_id,
    binding: FileSyncBinding,
    root: Path,
    storage_root: Path,
    scope_prefix: str,
    user_root: Path,
    workspace_directory_id: int | None,
    relative: str,
    latest: dict[tuple[str, str], FileSyncJournal],
    stat_cache: StatCache | None,
    quota_headroom: int,
    summary_inout: dict,
) -> int:
    """单文件 create/update 投影；返回新建文件占用的字节数（未新建返回 0）。

    调用方必须按返回值在循环内逐个扣减批次 quota headroom：headroom 在批次
    开始时只算一次，若不随新建扣减，同批多个大文件会各自拿同一份余量、批量
    突破存储配额。同批的删除文件不回补余量（删除投影排在创建之后，按不回补
    处理方向保守，不会超卖配额）。
    """
    path = root / relative
    key = scope_prefix + relative
    created_bytes = 0
    try:
        if _is_sync_temporary(path):
            return 0
        validate_sync_path(root, relative)
        _safe_storage_key(storage_root, path)
        space, project_id, folder_id, display_name, ext, file_ws_dir_id = await _classify_path(
            db, user_id, path, user_root,
            workspace_directory_id=workspace_directory_id, base=root,
        )
        observed = stat_cache.lookup(relative, path) if stat_cache else None
        if observed is None:
            observed = _stable_fingerprint(path)
            if stat_cache:
                stat_cache.store(relative, path, observed)
    except (OSError, ValueError):
        summary_inout["rejected"] += 1
        return 0

    row = (await db.execute(select(File).where(
        File.user_id == user_id, File.storage_key == key, File.deleted_at.is_(None),
    ))).scalar_one_or_none()
    if row is None:
        source = await _find_move_source(db, binding, scope_prefix, relative, observed, root)
    else:
        source = None

    if row is not None and source is None:
        previous = latest.get(("file", relative))
        if previous is not None and previous.observed_fingerprint == observed:
            return 0
        row.size_bytes = path.stat().st_size
        row.size = str(path.stat().st_size)
        row.display_name = display_name
        row.ext = ext
        row.space = space
        row.project_id = project_id
        row.folder_id = folder_id
        row.workspace_directory_id = file_ws_dir_id
        row.version = int(row.version or 1) + 1
        row.updated_at = now_utc()
        # 文件正文变了，旧缩略图即使仍在磁盘也不能继续返回。
        delete_thumb_cache(row.id, storage_root)
        operation = FileSyncOperation.UPDATE
        summary_inout["updated"] += 1
        baseline = previous.observed_fingerprint if previous else None
    elif source is not None:
        row = source
        old_key = row.storage_key
        row.storage_key = key
        row.display_name = display_name
        row.ext = ext
        row.space = space
        row.project_id = project_id
        row.folder_id = folder_id
        row.workspace_directory_id = file_ws_dir_id
        row.size_bytes = path.stat().st_size
        row.size = str(path.stat().st_size)
        row.version = int(row.version or 1) + 1
        row.updated_at = now_utc()
        operation = FileSyncOperation.MOVE
        summary_inout["moved"] += 1
        old_journal = latest.get(("file", old_key.removeprefix(scope_prefix)))
        baseline = old_journal.observed_fingerprint if old_journal else None
    else:
        if path.stat().st_size > quota_headroom:
            summary_inout["rejected"] += 1
            return 0
        stat = path.stat()
        created_bytes = stat.st_size
        row = File(
            user_id=user_id, display_name=display_name, ext=ext, space=space,
            project_id=project_id, folder_id=folder_id,
            workspace_directory_id=file_ws_dir_id, stage_name="",
            storage_key=key, storage_backend="local", size=str(stat.st_size),
            size_bytes=stat.st_size, mime_type=mimetypes.guess_type(path.name)[0],
        )
        db.add(row)
        await db.flush()
        operation = FileSyncOperation.CREATE
        summary_inout["created"] += 1
        baseline = None
    journal = await record_change(
        db, binding=binding, user_id=user_id, source=str(FileSyncSource.LOCAL_DIRECTORY),
        operation=operation, relative_path=relative,
        idempotency_key=build_idempotency_key(
            source=str(FileSyncSource.LOCAL_DIRECTORY), operation=str(operation),
            relative_path=relative, fingerprint=observed,
        ),
        baseline_fingerprint=baseline, observed_fingerprint=observed,
        status=FileSyncStatus.SYNCED,
    )
    latest[("file", relative)] = journal
    summary_inout["journal_ids"].append(journal.id)
    summary_inout["entity_ids"].append(row.id)
    try:
        save_snapshot(user_id, binding.id, relative, path)
    except OSError:
        summary_inout["rejected"] += 1
    return created_bytes


async def _project_deleted_file(
    db: AsyncSession, user_id, binding: FileSyncBinding, storage_root: Path,
    scope_prefix: str, relative: str,
    latest: dict[tuple[str, str], FileSyncJournal], summary_inout: dict,
) -> None:
    key = scope_prefix + relative
    row = (await db.execute(select(File).where(
        File.user_id == user_id, File.storage_key == key, File.deleted_at.is_(None),
    ))).scalar_one_or_none()
    # 行不存在说明移动投影已复用（或此前已处理）；盘上还在则事件过期，跳过。
    if row is None or (storage_root / key).exists():
        return
    row.deleted_at = now_utc()
    row.version = int(row.version or 1) + 1
    row.updated_at = now_utc()
    delete_thumb_cache(row.id, storage_root)
    summary_inout["deleted"] += 1
    summary_inout["entity_ids"].append(row.id)
    previous = latest.get(("file", relative))
    journal = await record_change(
        db, binding=binding, user_id=user_id, source=str(FileSyncSource.LOCAL_DIRECTORY),
        operation=FileSyncOperation.DELETE, relative_path=relative,
        idempotency_key=build_idempotency_key(
            source=str(FileSyncSource.LOCAL_DIRECTORY), operation=str(FileSyncOperation.DELETE),
            relative_path=relative, fingerprint=str(row.version),
        ),
        baseline_fingerprint=previous.observed_fingerprint if previous else None,
        observed_fingerprint=None, status=FileSyncStatus.SYNCED,
    )
    summary_inout["journal_ids"].append(journal.id)


async def _project_folder_created(
    db: AsyncSession, user_id, binding: FileSyncBinding, root: Path,
    user_root: Path, workspace_directory_id: int | None, relative: str,
    latest: dict[tuple[str, str], FileSyncJournal], summary_inout: dict,
) -> None:
    directory = root / relative
    try:
        validate_sync_path(root, relative)
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError("目录不存在或是符号链接")
        if workspace_directory_id is not None:
            space, project_id, folder_names = "workspace", None, list(directory.relative_to(root).parts)
        else:
            parsed = _parse_directory_path(directory, user_root)
            if parsed is None:
                summary_inout["rejected"] += 1
                return
            space, project_id, folder_names = parsed
        if project_id is not None and await get_owned(db, Project, project_id, user_id) is None:
            raise ValueError("项目不属于当前用户")
    except (OSError, ValueError):
        summary_inout["rejected"] += 1
        return

    from app.services.filesync.reconcile import _ensure_folder_path
    folder_id, was_created = await _ensure_folder_path(
        db, user_id, space=space, project_id=project_id, folder_names=folder_names,
        workspace_directory_id=workspace_directory_id,
    )
    if folder_id is None:
        return
    observed = _directory_fingerprint(directory)
    previous = latest.get(("folder", relative))
    if previous is not None and previous.observed_fingerprint == observed:
        return
    if previous is None:
        operation = FileSyncOperation.CREATE if was_created else FileSyncOperation.BASELINE
    else:
        operation = FileSyncOperation.UPDATE
    journal = await record_change(
        db, binding=binding, user_id=user_id, source=str(FileSyncSource.LOCAL_DIRECTORY),
        operation=operation, object_type="folder", relative_path=relative,
        idempotency_key=build_idempotency_key(
            source=str(FileSyncSource.LOCAL_DIRECTORY), operation=str(operation),
            object_type="folder", relative_path=relative, fingerprint=observed,
        ),
        observed_fingerprint=observed, status=FileSyncStatus.SYNCED,
    )
    latest[("folder", relative)] = journal
    summary_inout["journal_ids"].append(journal.id)
    summary_inout["entity_ids"].append(folder_id)
    if operation == FileSyncOperation.CREATE:
        summary_inout["folders_created"] += 1
    elif operation == FileSyncOperation.UPDATE:
        summary_inout["folders_updated"] += 1


async def _project_folder_deleted(
    db: AsyncSession, user_id, binding: FileSyncBinding, root: Path,
    user_root: Path, workspace_directory_id: int | None, relative: str,
    latest: dict[tuple[str, str], FileSyncJournal], summary_inout: dict,
) -> None:
    parts = [item for item in relative.split("/") if item]
    if not parts:
        return
    try:
        if workspace_directory_id is not None:
            space, project_id = "workspace", None
        else:
            parsed = _parse_directory_path(root / relative, user_root)
            if parsed is None:
                return
            space, project_id, _ = parsed
        folder_id = await _find_folder_path(
            db, user_id, space=space, project_id=project_id, folder_names=parts,
            workspace_directory_id=workspace_directory_id,
        )
    except (OSError, ValueError):
        summary_inout["rejected"] += 1
        return
    if folder_id is None:
        return
    folder = await db.get(Folder, folder_id)
    if folder is None or folder.deleted_at is not None:
        return
    # 保守删除：仍有活动文件或子目录时不动，交给日级补偿整树裁决。
    live_file = await db.scalar(select(func.count()).select_from(File).where(
        File.folder_id == folder_id, File.deleted_at.is_(None),
    ))
    live_child = await db.scalar(select(func.count()).select_from(Folder).where(
        Folder.parent_id == folder_id, Folder.deleted_at.is_(None),
    ))
    if (live_file or 0) or (live_child or 0):
        return
    folder.deleted_at = now_utc()
    folder.version = int(folder.version or 1) + 1
    folder.updated_at = now_utc()
    summary_inout["folders_deleted"] += 1
    summary_inout["entity_ids"].append(folder.id)
    journal = await record_change(
        db, binding=binding, user_id=user_id, source=str(FileSyncSource.LOCAL_DIRECTORY),
        operation=FileSyncOperation.DELETE, object_type="folder", relative_path=relative,
        idempotency_key=build_idempotency_key(
            source=str(FileSyncSource.LOCAL_DIRECTORY), operation=str(FileSyncOperation.DELETE),
            object_type="folder", relative_path=relative, fingerprint=str(folder.version),
        ),
        baseline_fingerprint=(latest.get(("folder", relative)).observed_fingerprint
                              if latest.get(("folder", relative)) else None),
        status=FileSyncStatus.SYNCED,
    )
    summary_inout["journal_ids"].append(journal.id)


async def project_path_events(
    db: AsyncSession,
    user_id,
    binding: FileSyncBinding,
    root: Path,
    batch: PathEventBatch,
    *,
    allow_delete: bool = True,
) -> SyncSummary:
    """把一批 sidecar 路径事件投影为 File/Folder 单点变更。"""
    if not is_file_sync_enabled() or not workspace_shell_supported():
        return SyncSummary(rejected=1)
    settings = get_settings()
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    user_root = (storage_root / str(user_id)).resolve()
    try:
        root.relative_to(user_root)
    except ValueError:
        return SyncSummary(rejected=1)
    if not root.exists() or not root.is_dir():
        return SyncSummary(rejected=1)
    workspace_directory_id: int | None = None
    if binding.workspace_id is not None:
        workspace_directory_id = await _workspace_directory_id_for(db, user_id, binding.workspace_id)

    scope_prefix = _scope_prefix(storage_root, root)
    latest = await _latest_journals(db, binding.id, batch.all_paths())
    stat_cache = StatCache(user_id, binding.id)
    quota_limit = await _quota_limit(db, user_id)
    summary_inout: dict = {
        "created": 0, "updated": 0, "moved": 0, "deleted": 0, "rejected": 0,
        "folders_created": 0, "folders_updated": 0, "folders_deleted": 0,
        "journal_ids": [], "entity_ids": [],
    }

    # 顺序：新目录 → 文件创建/更新（含移动重挂）→ 文件删除 → 空目录删除。
    # 先建后删让「改名 = unlink+add」事件对在删除前完成移动识别。
    for relative in sorted(batch.folders_created):
        await _project_folder_created(
            db, user_id, binding, root, user_root, workspace_directory_id, relative, latest, summary_inout,
        )
    quota_headroom = quota_limit - await _live_storage_bytes(db, user_id)
    for relative in sorted(batch.changed):
        # 新建文件逐个扣减余量：同批文件共享同一份额度，不扣减会批量突破配额
        quota_headroom -= await _project_changed_file(
            db, user_id, binding, root, storage_root, scope_prefix, user_root,
            workspace_directory_id, relative, latest, stat_cache,
            quota_headroom, summary_inout,
        )
    if allow_delete:
        for relative in sorted(batch.deleted):
            await _project_deleted_file(
                db, user_id, binding, storage_root, scope_prefix, relative, latest, summary_inout,
            )
        for relative in sorted(batch.folders_deleted, key=lambda item: item.count("/"), reverse=True):
            await _project_folder_deleted(
                db, user_id, binding, root, user_root, workspace_directory_id, relative, latest, summary_inout,
            )
    if stat_cache is not None:
        # 单点运行只覆盖个别路径，不裁剪整树 reconcile 攒下来的全量条目。
        stat_cache.save(prune=False)
    binding.last_reconciled_at = now_utc()
    await db.flush()
    scanned = len(batch.changed) + len(batch.deleted) + len(batch.folders_created) + len(batch.folders_deleted)
    return SyncSummary(
        scanned=scanned,
        created=summary_inout["created"], updated=summary_inout["updated"],
        moved=summary_inout["moved"], deleted=summary_inout["deleted"],
        rejected=summary_inout["rejected"],
        folders_created=summary_inout["folders_created"],
        folders_updated=summary_inout["folders_updated"],
        folders_deleted=summary_inout["folders_deleted"],
        journal_ids=tuple(summary_inout["journal_ids"]),
        entity_ids=tuple(summary_inout["entity_ids"]),
    )
