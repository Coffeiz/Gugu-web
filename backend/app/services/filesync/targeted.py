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

from sqlalchemy import func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


def _record_rejection(summary: dict, reason: str) -> None:
    summary["rejected"] += 1
    reasons = summary["rejection_reasons"]
    reasons[reason] = reasons.get(reason, 0) + 1


def _path_rejection_reason(exc: BaseException, *, object_type: str) -> str:
    if isinstance(exc, PermissionError):
        return f"{object_type}_unavailable"
    if isinstance(exc, OSError):
        return f"{object_type}_filesystem_error"
    return "invalid_or_unsupported_path"

from app.core.config import get_settings
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import File, FileSyncBinding, FileSyncJournal, Folder, Project, StorageQuotaLedger, User
from app.services.files.previews import delete_thumb_cache
from app.services.filesync.protocol import (
    FileSyncOperation,
    FileSyncSource,
    FileSyncStatus,
    build_idempotency_key,
    lock_file_sync_paths,
    is_file_sync_enabled,
    record_change,
    validate_sync_path,
)
from app.services.filesync.reconcile import (
    FileChangedDuringRead,
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
from app.services.workspaces import workspace_shell_supported
from app.services.storage.quota_limits import resolve_file_library_limit


@dataclass
class PathEventBatch:
    """同一绑定在相邻两次 drain 之间累积的路径事件；changed/deleted 互斥收敛。"""

    changed: set[str] = field(default_factory=set)
    created_files: set[str] = field(default_factory=set)
    deleted: set[str] = field(default_factory=set)
    folders_created: set[str] = field(default_factory=set)
    folders_deleted: set[str] = field(default_factory=set)

    def empty(self) -> bool:
        return not (self.changed or self.deleted or self.folders_created or self.folders_deleted)

    def all_paths(self) -> set[str]:
        return self.changed | self.deleted | self.folders_created | self.folders_deleted


@dataclass(frozen=True)
class PathProjectionOptions:
    """扫描投影的复核证据；普通实时事件使用默认选项。"""

    allow_delete: bool = True
    verified_files: dict[str, tuple[int, int, int, str]] | None = None
    observed_folders: dict[str, str] | None = None
    record_quota_deltas: bool = False
    enforce_quota: bool = True


async def _quota_limit(db: AsyncSession, user_id) -> int:
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    quota_settings = getattr(get_settings(), "quota", None)
    return resolve_file_library_limit(
        user.storage_limit_bytes if user else None,
        getattr(quota_settings, "default_storage_limit_bytes", None),
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
    """仅在最新 Journal 对应唯一活动 File 且旧物理路径已消失时复用身份。

    相同内容不是文件身份。遇到多个已消失的同指纹候选时宁可新建记录，也不猜测
    哪个 File 被移动；候选上限用于限制常见相同内容文件造成的查询工作集。
    """
    ranked = select(
        FileSyncJournal.relative_path.label("relative_path"),
        FileSyncJournal.observed_fingerprint.label("observed_fingerprint"),
        func.row_number().over(
            partition_by=FileSyncJournal.relative_path,
            order_by=FileSyncJournal.id.desc(),
        ).label("path_rank"),
    ).where(
        FileSyncJournal.binding_id == binding.id,
        FileSyncJournal.status == FileSyncStatus.SYNCED,
        FileSyncJournal.object_type == "file",
        FileSyncJournal.relative_path != relative,
    ).subquery()
    candidates = (await db.execute(
        select(File.id, ranked.c.relative_path)
        .join(
            ranked,
            File.storage_key == literal(scope_prefix) + ranked.c.relative_path,
        )
        .where(
            File.user_id == binding.user_id,
            File.deleted_at.is_(None),
            ranked.c.path_rank == 1,
            ranked.c.observed_fingerprint == observed,
        )
        .order_by(File.id)
        .limit(257)
    )).all()
    if len(candidates) > 256:
        return None

    # PostgreSQL rejects FOR UPDATE on a SELECT that contains a window-function
    # subquery. Discover candidates first, then lock only the File rows in a
    # separate query and revalidate their active storage keys.
    candidate_paths = {file_id: old_relative for file_id, old_relative in candidates}
    if not candidate_paths:
        return None
    rows = (await db.scalars(
        select(File)
        .where(
            File.id.in_(candidate_paths),
            File.user_id == binding.user_id,
            File.deleted_at.is_(None),
        )
        .order_by(File.id)
        .with_for_update()
    )).all()
    missing = [
        row for row in rows
        if row.storage_key == f"{scope_prefix}{candidate_paths[row.id]}"
        and not (root / candidate_paths[row.id]).exists()
    ]
    return missing[0] if len(missing) == 1 else None


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
    quota_headroom: int,
    summary_inout: dict,
    verified_file: tuple[int, int, int, str] | None = None,
    *,
    record_quota_delta: bool = False,
    created_event: bool = False,
    observed_external_change: bool = False,
    enforce_quota: bool = True,
) -> int:
    """单文件 create/update 投影；返回本次变更的净字节增量。

    调用方必须按返回值在循环内逐个扣减批次 quota headroom：headroom 在批次
    开始时只算一次，若不随新建扣减，同批多个大文件会各自拿同一份余量、批量
    突破存储配额。扩容扣除增长部分，缩小文件则释放相应余量。
    """
    path = root / relative
    key = scope_prefix + relative
    size_delta = 0
    try:
        if _is_sync_temporary(path):
            return 0
        validate_sync_path(root, relative)
        _safe_storage_key(storage_root, path)
        classification = await _classify_path(
            db, user_id, path, user_root,
            workspace_directory_id=workspace_directory_id, base=root,
        )
        if classification is None:
            return 0
        space, project_id, folder_id, display_name, ext, file_ws_dir_id = classification
        # 精确事件与手动扫描都必须核对正文；手动扫描可传入线程内刚复核的指纹，
        # 避免把大文件哈希放回事件循环。
        if verified_file is None:
            observed = _stable_fingerprint(path)
        else:
            current = path.stat(follow_symlinks=False)
            if (current.st_size, current.st_mtime_ns, current.st_ino) != verified_file[:3]:
                raise FileChangedDuringRead("文件在扫描后发生变化")
            observed = verified_file[3]
    except (FileNotFoundError, FileChangedDuringRead):
        if verified_file is not None:
            # 手动对账的复核证据已失效，不能作为成功覆盖项；保留缺口等待再次核对。
            _record_rejection(summary_inout, "file_io")
            return 0
        # watcher 事件排队期间文件可能已被删除、移动或仍在写入；这是过期/中间态事件，
        # 后续 unlink/change 会补齐事实，不应把正常文件活动记为同步缺口。
        return 0
    except (OSError, ValueError) as exc:
        _record_rejection(summary_inout, _path_rejection_reason(exc, object_type="file"))
        return 0

    row = (await db.execute(select(File).where(
        File.user_id == user_id, File.storage_key == key, File.deleted_at.is_(None),
    ).with_for_update())).scalar_one_or_none()
    if row is None:
        source = await _find_move_source(db, binding, scope_prefix, relative, observed, root)
    else:
        source = None

    if row is not None and source is None:
        previous = latest.get(("file", relative))
        stat = path.stat()
        expected_mime_type = mimetypes.guess_type(path.name)[0]
        if previous is not None and previous.observed_fingerprint == observed and (
            row.size_bytes == stat.st_size
            and row.display_name == display_name
            and row.ext == ext
            and row.space == space
            and row.project_id == project_id
            and row.folder_id == folder_id
            and row.workspace_directory_id == file_ws_dir_id
            and row.mime_type == expected_mime_type
        ):
            return 0
        size_delta = stat.st_size - int(row.size_bytes or 0)
        if enforce_quota and size_delta > quota_headroom and not observed_external_change:
            _record_rejection(summary_inout, "quota_exceeded")
            return 0
        row.size_bytes = stat.st_size
        row.size = str(stat.st_size)
        row.display_name = display_name
        row.ext = ext
        row.space = space
        row.project_id = project_id
        row.folder_id = folder_id
        row.workspace_directory_id = file_ws_dir_id
        row.mime_type = expected_mime_type
        row.version = int(row.version or 1) + 1
        row.updated_at = now_utc()
        # 文件正文变了，旧缩略图即使仍在磁盘也不能继续返回。
        delete_thumb_cache(row.id, storage_root)
        operation = FileSyncOperation.UPDATE
        summary_inout["updated"] += 1
        baseline = previous.observed_fingerprint if previous else None
    elif source is not None:
        row = source
        size_delta = path.stat().st_size - int(row.size_bytes or 0)
        if enforce_quota and size_delta > quota_headroom and not observed_external_change:
            _record_rejection(summary_inout, "quota_exceeded")
            return 0
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
        row.mime_type = mimetypes.guess_type(path.name)[0]
        row.version = int(row.version or 1) + 1
        row.updated_at = now_utc()
        operation = FileSyncOperation.MOVE
        summary_inout["moved"] += 1
        old_journal = latest.get(("file", old_key.removeprefix(scope_prefix)))
        baseline = old_journal.observed_fingerprint if old_journal else None
    else:
        size_delta = path.stat().st_size if created_event or not observed_external_change else 0
        if enforce_quota and size_delta > quota_headroom and not observed_external_change:
            _record_rejection(summary_inout, "quota_exceeded")
            return 0
        stat = path.stat()
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
    if record_quota_delta and size_delta:
        from app.services.storage.quota_ledger import FILE_LIBRARY, record_usage

        await record_usage(
            db, user_id, category=FILE_LIBRARY, delta_bytes=size_delta,
            operation="filesync_increment", resource_type="file", resource_id=row.id,
            idempotency_key=f"filesync-quota:{journal.id}",
            allow_over_limit=True,
        )
    try:
        save_snapshot(user_id, binding.id, relative, path)
    except OSError:
        _record_rejection(summary_inout, "snapshot_unavailable")
    return size_delta


async def _project_deleted_file(
    db: AsyncSession, user_id, binding: FileSyncBinding, storage_root: Path,
    scope_prefix: str, relative: str,
    latest: dict[tuple[str, str], FileSyncJournal], summary_inout: dict,
    *, record_quota_delta: bool = False,
) -> None:
    key = scope_prefix + relative
    row = (await db.execute(select(File).where(
        File.user_id == user_id, File.storage_key == key, File.deleted_at.is_(None),
    ).with_for_update())).scalar_one_or_none()
    # 行不存在说明移动投影已复用（或此前已处理）；盘上还在则事件过期，跳过。
    if row is None or (storage_root / key).exists():
        return
    deleted_size = int(row.size_bytes or 0)
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
    if record_quota_delta and deleted_size:
        from app.services.storage.quota_ledger import FILE_LIBRARY, record_usage

        await record_usage(
            db, user_id, category=FILE_LIBRARY, delta_bytes=-deleted_size,
            operation="filesync_increment", resource_type="file", resource_id=row.id,
            idempotency_key=f"filesync-quota:{journal.id}",
            allow_over_limit=True,
        )


async def _project_folder_created(
    db: AsyncSession, user_id, binding: FileSyncBinding, root: Path,
    user_root: Path, workspace_directory_id: int | None, relative: str,
    latest: dict[tuple[str, str], FileSyncJournal], summary_inout: dict,
    observed_fingerprint: str | None = None,
) -> None:
    directory = root / relative
    try:
        validate_sync_path(root, relative)
        if not directory.exists() and not directory.is_symlink():
            return
        if not directory.is_dir() or directory.is_symlink():
            if not directory.exists() and not directory.is_symlink():
                return
            raise ValueError("目录不存在或是符号链接")
        if workspace_directory_id is not None:
            space, project_id, folder_names = "workspace", None, list(directory.relative_to(root).parts)
        else:
            parsed = _parse_directory_path(directory, user_root)
            if parsed is None:
                # 用户根目录下的年月层、项目根等只是组织容器，并非文件库 Folder。
                # 旧版全量同步会跳过它们；精确事件也应保持为无副作用的忽略。
                return
            space, project_id, folder_names = parsed
        if project_id is not None and await get_owned(db, Project, project_id, user_id) is None:
            raise ValueError("项目不属于当前用户")
    except (OSError, ValueError) as exc:
        _record_rejection(summary_inout, _path_rejection_reason(exc, object_type="folder"))
        return

    from app.services.filesync.reconcile import _ensure_folder_path
    folder_id, was_created = await _ensure_folder_path(
        db, user_id, space=space, project_id=project_id, folder_names=folder_names,
        workspace_directory_id=workspace_directory_id,
    )
    if folder_id is None:
        return
    observed = observed_fingerprint or _directory_fingerprint(directory)
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
    # unlinkDir 可能是过期事件；若扫描/事件到达后目录已重建，绝不能把新的
    # 物理目录当成删除事实投影到文件库。
    directory = root / relative
    if directory.exists() or directory.is_symlink():
        return
    try:
        if workspace_directory_id is not None:
            space, project_id = "workspace", None
            folder_names = parts
        else:
            parsed = _parse_directory_path(root / relative, user_root)
            if parsed is None:
                return
            space, project_id, folder_names = parsed
        folder_id = await _find_folder_path(
            db, user_id, space=space, project_id=project_id, folder_names=folder_names,
            workspace_directory_id=workspace_directory_id,
        )
    except (OSError, ValueError) as exc:
        _record_rejection(summary_inout, _path_rejection_reason(exc, object_type="folder"))
        return
    if folder_id is None:
        return
    folder = await db.scalar(select(Folder).where(Folder.id == folder_id).with_for_update())
    if folder is None or folder.deleted_at is not None:
        return
    # 保守删除：仍有活动文件或子目录时不动，需显式手动核对。
    if await _folder_has_active_children(db, folder_id):
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


async def _folder_has_active_children(db: AsyncSession, folder_id: int) -> bool:
    live_file = await db.scalar(select(func.count()).select_from(File).where(
        File.folder_id == folder_id, File.deleted_at.is_(None),
    ))
    if live_file:
        return True
    live_child = await db.scalar(select(func.count()).select_from(Folder).where(
        Folder.parent_id == folder_id, Folder.deleted_at.is_(None),
    ))
    return bool(live_child)


def _projection_roots(user_id, root: Path) -> tuple[Path, Path] | None:
    """验证实时/手动投影根目录属于当前用户存储范围。"""
    if not is_file_sync_enabled() or not workspace_shell_supported():
        return None
    storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
    user_root = (storage_root / str(user_id)).resolve()
    try:
        root.relative_to(user_root)
    except ValueError:
        return None
    if not root.exists() or not root.is_dir():
        return None
    return storage_root, user_root


async def project_path_events(
    db: AsyncSession,
    user_id,
    binding: FileSyncBinding,
    root: Path,
    batch: PathEventBatch,
    *,
    options: PathProjectionOptions | None = None,
) -> SyncSummary:
    """把一批 sidecar 路径事件投影为 File/Folder 单点变更。"""
    options = options or PathProjectionOptions()
    roots = _projection_roots(user_id, root)
    if roots is None:
        return SyncSummary(rejected=1, rejection_reasons=(("projection_root_unavailable", 1),))
    storage_root, user_root = roots
    workspace_directory_id: int | None = None
    if binding.workspace_id is not None:
        workspace_directory_id = await _workspace_directory_id_for(db, user_id, binding.workspace_id)

    scope_prefix = _scope_prefix(storage_root, root)
    await lock_file_sync_paths(
        db,
        user_id,
        [scope_prefix + relative for relative in sorted(batch.all_paths())],
    )
    latest = await _latest_journals(db, binding.id, batch.all_paths())
    quota_limit = await _quota_limit(db, user_id)
    summary_inout: dict = {
        "created": 0, "updated": 0, "moved": 0, "deleted": 0, "rejected": 0,
        "rejection_reasons": {},
        "folders_created": 0, "folders_updated": 0, "folders_deleted": 0,
        "journal_ids": [], "entity_ids": [],
    }

    # 顺序：新目录 → 文件创建/更新（含移动重挂）→ 文件删除 → 空目录删除。
    # 先建后删让「改名 = unlink+add」事件对在删除前完成移动识别。
    for relative in sorted(batch.folders_created):
        await _project_folder_created(
            db, user_id, binding, root, user_root, workspace_directory_id, relative, latest, summary_inout,
            (options.observed_folders or {}).get(relative),
        )
    record_changed_deltas = options.record_quota_deltas
    if options.record_quota_deltas:
        from app.services.storage.quota_ledger import FILE_LIBRARY, get_quota

        ledger_existed = await db.scalar(select(StorageQuotaLedger.id).where(
            StorageQuotaLedger.user_id == user_id,
            StorageQuotaLedger.category == FILE_LIBRARY,
        )) is not None
        quota = await get_quota(db, user_id, FILE_LIBRARY)
        quota_headroom = quota_limit - int(quota.used_bytes) - int(quota.reserved_bytes)
        # 首次建账会先测量当前磁盘事实：新建/修改文件已包含在该快照中，不能再加一次；
        # 删除仍需扣掉数据库里此前登记的大小。
        record_changed_deltas = ledger_existed
    else:
        quota_headroom = quota_limit - await _live_storage_bytes(db, user_id)
    for relative in sorted(batch.changed):
        # 按净字节增量逐项更新余量：新增/扩容扣减，缩小文件释放余量。
        quota_headroom -= await _project_changed_file(
            db, user_id, binding, root, storage_root, scope_prefix, user_root,
            workspace_directory_id, relative, latest,
            quota_headroom, summary_inout, (options.verified_files or {}).get(relative),
            record_quota_delta=record_changed_deltas,
            created_event=relative in batch.created_files,
            observed_external_change=options.record_quota_deltas,
            enforce_quota=options.enforce_quota,
        )
    if options.allow_delete:
        for relative in sorted(batch.deleted):
            await _project_deleted_file(
                db, user_id, binding, storage_root, scope_prefix, relative, latest, summary_inout,
                record_quota_delta=options.record_quota_deltas,
            )
        for relative in sorted(batch.folders_deleted, key=lambda item: item.count("/"), reverse=True):
            await _project_folder_deleted(
                db, user_id, binding, root, user_root, workspace_directory_id, relative, latest, summary_inout,
            )
    await db.flush()
    scanned = len(batch.changed) + len(batch.deleted) + len(batch.folders_created) + len(batch.folders_deleted)
    return SyncSummary(
        scanned=scanned,
        created=summary_inout["created"], updated=summary_inout["updated"],
        moved=summary_inout["moved"], deleted=summary_inout["deleted"],
        rejected=summary_inout["rejected"],
        rejection_reasons=tuple(sorted(summary_inout["rejection_reasons"].items())),
        folders_created=summary_inout["folders_created"],
        folders_updated=summary_inout["folders_updated"],
        folders_deleted=summary_inout["folders_deleted"],
        journal_ids=tuple(summary_inout["journal_ids"]),
        entity_ids=tuple(summary_inout["entity_ids"]),
    )
