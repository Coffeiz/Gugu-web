"""文件同步 Admin 状态、对账和恢复编排。

Admin 只负责观测和调度，文件投影仍由 ``filesync.bindings`` 处理；实时本地目录投影
由 worker watcher 统一执行，Admin 不再是正常同步链路中的必经步骤。
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.tz import now_utc
from app.models import FileSyncBinding, FileSyncConflict, FileSyncJournal, FileSyncOutbox
from app.services.filesync.bindings import (
    BindingSyncResult,
    cleanup_stale_conflicts,
    dry_run_local_binding,
    resolve_sync_conflict,
    resolve_local_binding_root,
    sync_local_binding,
)
from app.services.filesync.outbox import deliver_file_event, enqueue_file_event
from app.services.filesync.protocol import FileSyncStatus, is_file_sync_enabled
from app.services.workspaces import resolve_workspace_root, workspace_shell_supported


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _safe_failure(error_code: str | None, status: str) -> str:
    """只向 Admin 返回稳定错误码，不把异常或用户内容带出。"""
    return str(error_code or status)


async def _grouped_counts(
    db: AsyncSession,
    model,
    column,
    *,
    user_id: UUID | None = None,
) -> dict[str, int]:
    query = select(column, func.count(model.id)).group_by(column)
    if user_id is not None:
        query = query.where(model.user_id == user_id)
    rows = (await db.execute(query)).all()
    return {str(status): int(count) for status, count in rows}


async def get_admin_sync_status(
    db: AsyncSession,
    *,
    user_id: UUID | None = None,
    failure_limit: int = 20,
    conflict_limit: int = 100,
) -> dict:
    """返回脱敏的同步运行面板数据，不读取文件正文或绝对路径。"""
    settings = get_settings()
    backend = str(settings.storage.backend)
    supported = backend == "local" and workspace_shell_supported()
    binding_query = select(FileSyncBinding).order_by(FileSyncBinding.updated_at.desc())
    if user_id is not None:
        binding_query = binding_query.where(FileSyncBinding.user_id == user_id)
    all_bindings = (await db.scalars(binding_query)).all()
    visible_bindings = all_bindings if supported else []

    stale_conflicts_cleaned = 0
    for row in visible_bindings:
        try:
            if row.workspace_id is not None:
                root = await resolve_workspace_root(db, row.user_id, row.workspace_id)
            else:
                _, root = resolve_local_binding_root(row.user_id, row.root_path)
            if root is not None:
                stale_conflicts_cleaned += await cleanup_stale_conflicts(
                    db, row, root=root,
                )
        except (OSError, ValueError, LookupError):
            # 状态页不能因为历史绑定路径失效而阻塞其它绑定展示。
            pass
    if stale_conflicts_cleaned:
        await db.commit()

    journal_counts = await _grouped_counts(db, FileSyncJournal, FileSyncJournal.status, user_id=user_id)
    conflict_counts = await _grouped_counts(db, FileSyncConflict, FileSyncConflict.status, user_id=user_id)
    outbox_counts = await _grouped_counts(db, FileSyncOutbox, FileSyncOutbox.status, user_id=user_id)

    binding_ids = [row.id for row in visible_bindings]
    journal_by_binding: dict[int, Counter] = {item: Counter() for item in binding_ids}
    conflict_by_binding: dict[int, Counter] = {item: Counter() for item in binding_ids}
    if binding_ids:
        for model, column, target in (
            (FileSyncJournal, FileSyncJournal.status, journal_by_binding),
            (FileSyncConflict, FileSyncConflict.status, conflict_by_binding),
        ):
            query = select(model.binding_id, column, func.count(model.id)).where(
                model.binding_id.in_(binding_ids)
            ).group_by(model.binding_id, column)
            for binding_id, status, count in (await db.execute(query)).all():
                target[int(binding_id)][str(status)] = int(count)

    bindings = []
    for row in visible_bindings:
        journals = journal_by_binding[row.id]
        conflicts = conflict_by_binding[row.id]
        bindings.append({
            "id": row.id,
            "userId": str(row.user_id),
            "source": row.source,
            "mode": row.mode,
            "status": row.status,
            "protocolVersion": row.protocol_version,
            # 这里只是用户存储根下的相对目录，不返回服务器绝对路径。
            "rootPath": row.root_path,
            "revision": row.revision,
            "lastReconciledAt": _iso(row.last_reconciled_at),
            "updatedAt": _iso(row.updated_at),
            "pendingJournal": journals.get(FileSyncStatus.PENDING.value, 0),
            "failedJournal": journals.get(FileSyncStatus.FAILED.value, 0),
            "rejectedJournal": journals.get(FileSyncStatus.REJECTED.value, 0),
            "pendingConflicts": conflicts.get("pending", 0),
        })

    failure_query = select(FileSyncJournal).where(
        FileSyncJournal.status.in_([FileSyncStatus.FAILED.value, FileSyncStatus.REJECTED.value])
    ).order_by(FileSyncJournal.updated_at.desc()).limit(failure_limit)
    if user_id is not None:
        failure_query = failure_query.where(FileSyncJournal.user_id == user_id)
    failures = [
        {
            "kind": "journal",
            "id": row.id,
            "bindingId": row.binding_id,
            "userId": str(row.user_id),
            "status": row.status,
            "operation": row.operation,
            "errorCode": _safe_failure(row.error_code, row.status),
            "updatedAt": _iso(row.updated_at),
        }
        for row in (await db.scalars(failure_query)).all()
    ]
    outbox_query = select(FileSyncOutbox).where(
        FileSyncOutbox.status == "pending"
    ).order_by(FileSyncOutbox.updated_at.desc()).limit(failure_limit)
    if user_id is not None:
        outbox_query = outbox_query.where(FileSyncOutbox.user_id == user_id)
    failures.extend({
        "kind": "outbox",
        "id": row.id,
        "userId": str(row.user_id),
        "status": row.status,
        "operation": row.operation,
        "errorCode": _safe_failure(row.last_error, row.status),
        "attempts": row.attempts,
        "updatedAt": _iso(row.updated_at),
    } for row in (await db.scalars(outbox_query)).all())

    conflict_query = select(FileSyncConflict).where(
        FileSyncConflict.status == "pending"
    ).order_by(FileSyncConflict.created_at.desc()).limit(conflict_limit)
    if user_id is not None:
        conflict_query = conflict_query.where(FileSyncConflict.user_id == user_id)
    conflicts = [
        {
            "id": row.id,
            "bindingId": row.binding_id,
            "userId": str(row.user_id),
            "relativePath": row.relative_path,
            "source": row.source,
            "status": row.status,
            "hasBaseline": bool(row.baseline_fingerprint),
            "hasLocal": bool(row.local_fingerprint),
            "hasRemote": bool(row.remote_fingerprint),
            "createdAt": _iso(row.created_at),
        }
        for row in (await db.scalars(conflict_query)).all()
    ] if supported else []

    return {
        "featureEnabled": is_file_sync_enabled(),
        "storageBackend": backend,
        "supported": supported,
        "workspaceShellSupported": workspace_shell_supported(),
        "ignoredBindingCount": 0 if supported else len(all_bindings),
        "bindings": bindings,
        "conflicts": conflicts,
        "failures": failures,
        "totals": {
            "bindings": len(visible_bindings),
            "journals": sum(journal_counts.values()),
            "pendingJournals": journal_counts.get(FileSyncStatus.PENDING.value, 0),
            "failedJournals": journal_counts.get(FileSyncStatus.FAILED.value, 0),
            "rejectedJournals": journal_counts.get(FileSyncStatus.REJECTED.value, 0),
            "pendingConflicts": conflict_counts.get("pending", 0) if supported else 0,
            "pendingOutbox": outbox_counts.get("pending", 0),
        },
        "generatedAt": now_utc().isoformat(),
    }


async def admin_dry_run_binding(db: AsyncSession, binding_id: int) -> BindingSyncResult:
    binding = await db.get(FileSyncBinding, binding_id)
    if binding is None:
        raise LookupError("同步绑定不存在")
    if not workspace_shell_supported():
        raise ValueError("当前存储模式不支持本地文件同步")
    return await dry_run_local_binding(
        db, binding.user_id, root_path=binding.root_path, mode=binding.mode
    )


async def admin_reconcile_binding(
    db: AsyncSession,
    binding_id: int,
    *,
    allow_delete: bool = False,
) -> BindingSyncResult:
    binding = await db.get(FileSyncBinding, binding_id)
    if binding is None:
        raise LookupError("同步绑定不存在")
    if not workspace_shell_supported():
        raise ValueError("当前存储模式不支持本地文件同步")
    try:
        _, root = resolve_local_binding_root(binding.user_id, binding.root_path)
        await cleanup_stale_conflicts(db, binding, root=root)
    except (OSError, ValueError, LookupError):
        # 正式对账仍由后续同步流程返回具体错误；历史绑定失效时不阻塞其它绑定。
        pass
    result = await sync_local_binding(
        db, binding.user_id, root_path=binding.root_path, mode=binding.mode,
        allow_delete=allow_delete,
    )
    if result.summary.entity_ids or result.summary.conflicts:
        outbox = await enqueue_file_event(
            db, binding.user_id, operation="refresh", source="local_directory",
            entity_ids=result.summary.entity_ids, revision=binding.revision,
        )
        await db.commit()
        await deliver_file_event(db, outbox)
        await db.commit()
    else:
        await db.commit()
    return result


async def admin_resolve_conflict(
    db: AsyncSession,
    conflict_id: int,
    resolution: str,
) -> FileSyncConflict:
    conflict = await db.get(FileSyncConflict, conflict_id)
    if conflict is None:
        raise LookupError("同步冲突不存在")
    if not is_file_sync_enabled():
        raise ValueError("文件同步未开启")
    if not workspace_shell_supported():
        raise ValueError("当前存储模式不支持本地文件同步")
    row = await resolve_sync_conflict(db, conflict.user_id, conflict_id, resolution)
    outbox = await enqueue_file_event(
        db, conflict.user_id, operation="refresh", source="local_directory", entity_ids=()
    )
    await db.commit()
    await deliver_file_event(db, outbox)
    await db.commit()
    return row
