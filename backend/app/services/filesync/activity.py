"""用户级文件树活动序号与每日周期水位。"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.models import FileSyncUserScanState


async def record_file_activity(db: AsyncSession, user_id) -> None:
    """记录服务端观察到的一次真实文件树变化，不保存路径或客户端时间。"""
    now = now_utc()
    values = {
        "user_id": user_id,
        "activity_seq": 1,
        "last_file_activity_at": now,
        "updated_at": now,
    }
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        statement = pg_insert(FileSyncUserScanState).values(**values)
    elif dialect == "sqlite":
        statement = sqlite_insert(FileSyncUserScanState).values(**values)
    else:
        state = await db.get(FileSyncUserScanState, user_id)
        if state is None:
            db.add(FileSyncUserScanState(**values))
        else:
            state.activity_seq += 1
            state.last_file_activity_at = now
            state.updated_at = now
        return

    await db.execute(statement.on_conflict_do_update(
        index_elements=[FileSyncUserScanState.user_id],
        set_={
            "activity_seq": FileSyncUserScanState.activity_seq + 1,
            "last_file_activity_at": now,
            "updated_at": now,
        },
    ))


async def set_activity_reliability(
    db: AsyncSession, user_id, reliable: bool,
) -> None:
    state = await db.get(FileSyncUserScanState, user_id)
    if state is None:
        state = FileSyncUserScanState(user_id=user_id)
        db.add(state)
    state.activity_reliable = reliable
    state.updated_at = now_utc()


async def evaluate_daily_cycle(
    db: AsyncSession,
    state: FileSyncUserScanState,
    *,
    now: datetime | None = None,
    interval_seconds: float = 86400,
) -> str | None:
    """推进到期周期，返回 `skipped_file_active`、`scan` 或 None。

    未确认监听/活动统计可靠时绝不把用户判定为健康活跃并跳过；周期跳过仅
    前进判断水位，不更新绑定的成功快照时间。
    """
    now = now or now_utc()
    if state.current_cycle_cutoff is None:
        state.current_cycle_cutoff = now
        state.cycle_activity_seq = state.activity_seq
        state.updated_at = now
        return None
    if state.current_cycle_cutoff + timedelta(seconds=interval_seconds) > now:
        return None

    active = state.activity_seq != state.cycle_activity_seq
    previous_cutoff = state.current_cycle_cutoff
    state.previous_cycle_cutoff = previous_cutoff
    state.current_cycle_cutoff = now
    state.cycle_activity_seq = state.activity_seq
    state.last_cycle_decision = (
        "skipped_file_active" if active and state.activity_reliable else "scan"
    )
    state.skip_reason = "file_activity" if active and state.activity_reliable else None
    state.updated_at = now
    return state.last_cycle_decision
