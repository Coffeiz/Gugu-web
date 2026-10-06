"""持久文件对账任务的 API DTO 映射。"""
from __future__ import annotations

from app.models import FileSyncReconcileRun


def reconcile_run_result(
    row: FileSyncReconcileRun, *, include_admin_fields: bool = False,
) -> dict:
    """序列化任务状态；管理员额外字段不泄漏到用户 API。"""
    result = {
        "id": str(row.id), "bindingId": row.binding_id,
        "mode": row.mode, "reason": row.reason,
        "status": row.status, "stage": row.stage,
        "dryRun": row.dry_run, "allowDelete": row.allow_delete,
        "progressCurrent": row.progress_current,
        "progressTotal": row.progress_total,
        "resultCounts": row.result_counts or {},
        "errorCode": row.error_code, "pauseReason": row.pause_reason,
        "nextRunAt": row.next_run_at.isoformat() if row.next_run_at else None,
        "cumulativeRuntimeSeconds": row.cumulative_runtime_seconds,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
        "startedAt": row.started_at.isoformat() if row.started_at else None,
        "finishedAt": row.finished_at.isoformat() if row.finished_at else None,
    }
    if include_admin_fields:
        result["userId"] = str(row.user_id)
        result["checkpointRef"] = row.checkpoint_ref
    return result
