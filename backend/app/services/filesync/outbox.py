"""文件同步 canonical 事件 outbox：主事务内入队，提交后投递，失败可重试。"""
from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.tz import now_utc
from app.models import FileSyncOutbox


async def enqueue_file_event(
    db: AsyncSession,
    user_id,
    *,
    operation: str = "refresh",
    entity_ids: tuple[int, ...] | list[int] = (),
    source: str | None = None,
    revision: int | None = None,
) -> FileSyncOutbox:
    row = FileSyncOutbox(
        user_id=user_id,
        event_id=f"evt-{uuid.uuid4().hex}",
        resource="files",
        operation=operation,
        entity_ids=list(entity_ids),
        source=source,
        revision=revision,
    )
    db.add(row)
    await db.flush()
    return row


async def deliver_file_event(db: AsyncSession, row: FileSyncOutbox) -> bool:
    """投递单条事件；失败只更新重试水位，不影响已经提交的文件事务。"""
    try:
        delivered = await events.publish(
            row.user_id, row.resource,
            operation=row.operation,
            entity_ids=row.entity_ids or None,
            event_id=row.event_id,
            source=row.source,
        )
    except Exception:
        delivered = False
    if delivered:
        row.status = "delivered"
        row.delivered_at = now_utc()
        row.updated_at = now_utc()
        row.last_error = None
    else:
        row.status = "pending"
        row.attempts = int(row.attempts or 0) + 1
        row.next_attempt_at = now_utc() + timedelta(seconds=min(300, 2 ** min(row.attempts, 8)))
        row.last_error = "publish_failed"
        row.updated_at = now_utc()
    await db.flush()
    return delivered


async def deliver_pending_file_events(db: AsyncSession, *, limit: int = 50) -> int:
    rows = (await db.scalars(
        select(FileSyncOutbox)
        .where(
            FileSyncOutbox.status == "pending",
            FileSyncOutbox.next_attempt_at <= now_utc(),
        )
        .order_by(FileSyncOutbox.id)
        .limit(limit)
    )).all()
    delivered = 0
    for row in rows:
        delivered += int(await deliver_file_event(db, row))
    if rows:
        await db.commit()
    return delivered
