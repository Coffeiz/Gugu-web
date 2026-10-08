"""将绑定范围内的活动 File/Folder 记录分页暂存到扫描清单。"""
from __future__ import annotations

from pathlib import Path
from threading import Event

from sqlalchemy import func, select

from app.core.config import get_settings
from app.models import File, FileSyncJournal, Folder
from app.services.filesync.scan import ScanIncomplete, ScanManifest, connect_manifest
from app.services.filesync.protocol import FileSyncStatus
from app.services.storage.folders import folder_dir_key

_FILE_PAGE_SIZE = 256
_FOLDER_PAGE_SIZE = 64


async def stage_database_inventory(
    session_factory,
    *,
    user_id,
    binding_id: int,
    root: Path,
    manifest: ScanManifest,
    max_manifest_bytes: int,
    stop_event: Event | None = None,
    included_root_entries: frozenset[str] | None = None,
) -> tuple[int, int]:
    """分批收集完整范围内的活动记录；每页释放 DB session，不保留整树 ORM 对象。

    磁盘扫描已成功并生成清单后才调用。重复 storage_key 不会被合并，交给差异
    归并标记为歧义，避免迁移/对账任意挑选一条记录。
    """
    storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
    try:
        root = root.resolve(strict=True)
        root.relative_to(storage_root)
    except (OSError, ValueError) as exc:
        raise ScanIncomplete("同步根目录已失效", code="binding_root_unavailable") from exc
    scope_prefix = root.relative_to(storage_root).as_posix().rstrip("/") + "/"

    file_count = await _stage_files(
        session_factory,
        user_id=user_id,
        binding_id=binding_id,
        scope_prefix=scope_prefix,
        manifest=manifest,
        max_manifest_bytes=max_manifest_bytes,
        stop_event=stop_event,
        included_root_entries=included_root_entries,
    )
    folder_count = await _stage_folders(
        session_factory,
        user_id=user_id,
        binding_id=binding_id,
        root=root,
        storage_root=storage_root,
        manifest=manifest,
        max_manifest_bytes=max_manifest_bytes,
        stop_event=stop_event,
        included_root_entries=included_root_entries,
    )
    return file_count, folder_count


async def _stage_files(
    session_factory,
    *,
    user_id,
    binding_id: int,
    scope_prefix: str,
    manifest: ScanManifest,
    max_manifest_bytes: int,
    stop_event: Event | None = None,
    included_root_entries: frozenset[str] | None = None,
) -> int:
    last_id = 0
    staged = 0
    while True:
        if stop_event is not None and stop_event.is_set():
            raise InterruptedError("核对任务已停止")
        async with session_factory() as db:
            rows = list((await db.scalars(
                select(File)
                .where(
                    File.user_id == user_id,
                    File.deleted_at.is_(None),
                    File.storage_key.startswith(scope_prefix, autoescape=True),
                    *([File.space.in_(("personal", "project"))] if included_root_entries is not None else []),
                    File.id > last_id,
                )
                .order_by(File.id)
                .limit(_FILE_PAGE_SIZE)
            )).all())
            if not rows:
                await db.rollback()
                break
            last_id = rows[-1].id
            scoped_rows = [
                row for row in rows
                if included_root_entries is None
                or row.storage_key[len(scope_prefix):].split("/", 1)[0] in included_root_entries
            ]
            if not scoped_rows:
                await db.rollback()
                continue
            relative_paths = [row.storage_key[len(scope_prefix):] for row in scoped_rows]
            ranked_journals = select(
                FileSyncJournal.relative_path.label("relative_path"),
                FileSyncJournal.observed_fingerprint.label("observed_fingerprint"),
                FileSyncJournal.updated_at.label("updated_at"),
                func.row_number().over(
                    partition_by=FileSyncJournal.relative_path,
                    order_by=FileSyncJournal.id.desc(),
                ).label("path_rank"),
            ).where(
                FileSyncJournal.binding_id == binding_id,
                FileSyncJournal.status == FileSyncStatus.SYNCED,
                FileSyncJournal.object_type == "file",
                FileSyncJournal.relative_path.in_(relative_paths),
            ).subquery()
            journals = (await db.execute(
                select(
                    ranked_journals.c.relative_path,
                    ranked_journals.c.observed_fingerprint,
                    ranked_journals.c.updated_at,
                )
                .where(ranked_journals.c.path_rank == 1)
            )).all()
            journal_facts: dict[str, tuple[str | None, float | None]] = {}
            for relative_path, fingerprint, updated_at in journals:
                journal_facts.setdefault(
                    relative_path,
                    (fingerprint, updated_at.timestamp() if updated_at else None),
                )
            values = [
                (
                    row.id,
                    row.storage_key[len(scope_prefix):],
                    row.storage_key,
                    int(row.size_bytes or 0),
                    int(row.version or 1),
                    row.display_name,
                    row.ext,
                    row.space,
                    row.project_id,
                    row.folder_id,
                    row.workspace_directory_id,
                    row.mime_type,
                    journal_facts.get(row.storage_key[len(scope_prefix):], (None, None))[0],
                    row.updated_at.timestamp() if row.updated_at else None,
                    journal_facts.get(row.storage_key[len(scope_prefix):], (None, None))[1],
                )
                for row in scoped_rows
            ]
            await db.rollback()
        connection = connect_manifest(manifest)
        try:
            connection.executemany(
                "INSERT INTO db_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", values,
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        staged += len(values)
        _ensure_manifest_within_budget(manifest, max_manifest_bytes)
    return staged


async def _stage_folders(
    session_factory,
    *,
    user_id,
    binding_id: int,
    root: Path,
    storage_root: Path,
    manifest: ScanManifest,
    max_manifest_bytes: int,
    stop_event: Event | None = None,
    included_root_entries: frozenset[str] | None = None,
) -> int:
    last_id = 0
    staged = 0
    while True:
        if stop_event is not None and stop_event.is_set():
            raise InterruptedError("核对任务已停止")
        async with session_factory() as db:
            rows = list((await db.scalars(
                select(Folder)
                .where(
                    Folder.user_id == user_id,
                    Folder.deleted_at.is_(None),
                    *([Folder.workspace_directory_id.is_(None)] if included_root_entries is not None else []),
                    Folder.id > last_id,
                )
                .order_by(Folder.id)
                .limit(_FOLDER_PAGE_SIZE)
            )).all())
            if not rows:
                await db.rollback()
                break
            last_id = rows[-1].id
            folder_paths: list[tuple[int, str, int]] = []
            for folder in rows:
                key = await folder_dir_key(db, user_id, folder)
                if key is None:
                    continue
                try:
                    relative = (storage_root / key).resolve().relative_to(root).as_posix()
                except (OSError, ValueError):
                    continue
                # 绑定根本身可能有对应的 Folder 锚点，但它不是根内的子目录对象。
                if relative == ".":
                    continue
                if (
                    included_root_entries is not None
                    and relative.split("/", 1)[0] not in included_root_entries
                ):
                    continue
                folder_paths.append((folder.id, relative, int(folder.version or 1)))
            journal_rows = (await db.execute(
                select(FileSyncJournal.relative_path, FileSyncJournal.observed_fingerprint)
                .where(
                    FileSyncJournal.binding_id == binding_id,
                    FileSyncJournal.status == FileSyncStatus.SYNCED,
                    FileSyncJournal.object_type == "folder",
                    FileSyncJournal.relative_path.in_([path for _, path, _ in folder_paths]),
                )
                .order_by(FileSyncJournal.id.desc())
            )).all() if folder_paths else []
            fingerprints: dict[str, str | None] = {}
            for relative_path, fingerprint in journal_rows:
                fingerprints.setdefault(relative_path, fingerprint)
            values = [
                (folder_id, relative, version, fingerprints.get(relative))
                for folder_id, relative, version in folder_paths
            ]
            await db.rollback()
        if values:
            connection = connect_manifest(manifest)
            try:
                connection.executemany("INSERT INTO db_folders VALUES (?, ?, ?, ?)", values)
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()
            staged += len(values)
            _ensure_manifest_within_budget(manifest, max_manifest_bytes)
    return staged


def _ensure_manifest_within_budget(manifest: ScanManifest, max_manifest_bytes: int) -> None:
    try:
        size = manifest.path.stat().st_size
    except OSError as exc:
        raise ScanIncomplete("临时清单不可读取", code="scan_manifest_unavailable") from exc
    if size > max_manifest_bytes:
        raise ScanIncomplete("临时清单超过空间预算", code="scan_manifest_budget_exceeded")
