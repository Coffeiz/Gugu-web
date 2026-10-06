"""持久对账队列的优先级老化与用户内绑定轮转规则。"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import case, func

from app.models import FileSyncReconcileRun, FileSyncUserScanState


_PRIORITY_REASONS = (
    "bootstrap", "file_event", "event_fallback", "restart_recovery",
    "snapshot_invalid", "manual",
)
_AGING_STEPS = (timedelta(minutes=3), timedelta(minutes=10), timedelta(minutes=30), timedelta(hours=1))


def effective_priority_order(now: datetime):
    """高优先级任务先处理；等待 3/10/30/60 分钟逐级老化，避免每日任务饥饿。"""
    base_priority = case(
        (FileSyncReconcileRun.reason.in_(_PRIORITY_REASONS), 0),
        else_=1,
    )
    age_credit = sum(
        case(
            (func.coalesce(
                FileSyncReconcileRun.priority_since,
                FileSyncReconcileRun.created_at,
            ) <= now - age, 1),
            else_=0,
        )
        for age in _AGING_STEPS
    )
    return (base_priority - age_credit).asc()


def binding_rotation_order():
    """从用户上次领取的绑定之后继续轮转，已到期的旧绑定不会独占续跑槽。"""
    last_binding_id = FileSyncUserScanState.last_binding_rotation_id
    return (
        case(
            (last_binding_id.is_(None), 0),
            (FileSyncReconcileRun.binding_id > last_binding_id, 0),
            else_=1,
        ),
        FileSyncReconcileRun.binding_id.asc(),
    )


def mark_binding_claimed(state: FileSyncUserScanState, binding_id: int) -> None:
    state.last_binding_rotation_id = binding_id
