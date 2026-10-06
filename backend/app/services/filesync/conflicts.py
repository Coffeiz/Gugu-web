"""对账候选批次的冲突检测；所有数据库工作都限制在短事务内。"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, Mapping

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import File, FileSyncBinding, FileSyncConflict, FileSyncJournal
from app.services.filesync.protocol import FileSyncMode, FileSyncSource, FileSyncStatus
from app.services.filesync.scan import ScanEntry


async def inspect_conflict_batch(
    db: AsyncSession,
    *,
    user_id,
    binding: FileSyncBinding,
    root: Path,
    user_root: Path,
    other_roots: tuple[Path, ...],
    candidate_paths: Iterable[str],
    entries: Mapping[str, ScanEntry],
    persist: bool,
) -> set[str]:
    """返回必须阻塞投影的路径，避免整树同步覆盖尚未解决的双边修改。

    调用方每次最多传入一个投影批次。这里不访问文件正文；候选指纹来自事务外
    的扫描结果，数据库查询和冲突登记因此不会把连接空闲地占在文件系统 I/O 上。
    """
    current_paths = tuple(
        path for path, entry in entries.items()
        if entry.object_type == "file"
    )
    paths = tuple(candidate_paths)
    if not paths:
        return set()

    pending = set((await db.scalars(select(FileSyncConflict.relative_path).where(
        FileSyncConflict.binding_id == binding.id,
        FileSyncConflict.status == "pending",
        FileSyncConflict.relative_path.in_(paths),
    ))).all())
    if binding.mode != FileSyncMode.BIDIRECTIONAL:
        return pending
    if not current_paths:
        return pending

    scope = root.relative_to(user_root).as_posix().rstrip("/")
    storage_prefix = f"{user_id}/" if scope in {"", "."} else f"{user_id}/{scope}/"
    storage_keys = {
        f"{storage_prefix}{path}": path
        for path in current_paths
    }
    file_rows = (await db.scalars(select(File).where(
        File.user_id == user_id,
        File.deleted_at.is_(None),
        File.storage_key.in_(storage_keys),
    ).with_for_update())).all()
    rows_by_path = {
        storage_keys[row.storage_key]: row
        for row in file_rows
        if row.storage_key in storage_keys
    }

    latest_ids = (
        select(func.max(FileSyncJournal.id).label("id"))
        .where(
            FileSyncJournal.binding_id == binding.id,
            FileSyncJournal.status == FileSyncStatus.SYNCED,
            FileSyncJournal.relative_path.in_(current_paths),
        )
        .group_by(FileSyncJournal.relative_path)
        .subquery()
    )
    latest_journals = (await db.scalars(select(FileSyncJournal).join(
        latest_ids, FileSyncJournal.id == latest_ids.c.id,
    ))).all()
    journals_by_path = {journal.relative_path: journal for journal in latest_journals}

    new_conflicts: list[FileSyncConflict] = []
    for relative_path in current_paths:
        absolute_path = root / relative_path
        if any(absolute_path.is_relative_to(other) for other in other_roots):
            continue
        row = rows_by_path.get(relative_path)
        journal = journals_by_path.get(relative_path)
        entry = entries[relative_path]
        if (
            row is None or journal is None or not journal.observed_fingerprint
            or row.updated_at <= journal.updated_at
            or entry.fingerprint == journal.observed_fingerprint
        ):
            continue
        pending.add(relative_path)
        if persist:
            new_conflicts.append(FileSyncConflict(
                binding_id=binding.id,
                user_id=user_id,
                relative_path=relative_path,
                baseline_fingerprint=journal.observed_fingerprint,
                local_fingerprint=entry.fingerprint,
                # journal 是最后成功投影的远端基线；不在事务内读取正文副本。
                remote_fingerprint=journal.observed_fingerprint,
                source=FileSyncSource.LOCAL_DIRECTORY,
                status="pending",
            ))

    if new_conflicts:
        # 冲突可能已由并发 targeted 路径登记；仅在没有 pending 行时补建。
        already_pending = set((await db.scalars(select(FileSyncConflict.relative_path).where(
            FileSyncConflict.binding_id == binding.id,
            FileSyncConflict.status == "pending",
            FileSyncConflict.relative_path.in_([row.relative_path for row in new_conflicts]),
        ))).all())
        db.add_all([
            row for row in new_conflicts
            if row.relative_path not in already_pending
        ])
        await db.flush()
    return pending
