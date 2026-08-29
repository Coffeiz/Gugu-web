from fastapi import APIRouter, Depends, Request
from sqlalchemy import select, desc, and_
from datetime import timedelta
from uuid import UUID
from fastapi import Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import AuditLog
from app.core.tz import now_utc

router = APIRouter(prefix="/admin/audit-log", tags=["admin"])


@router.get("/security-events")
async def list_security_events(
    event_type: str | None = None,
    action: str | None = None,
    resource_type: str | None = None,
    user_id: UUID | None = None,
    since_minutes: int = Query(1440, ge=1, le=90 * 24 * 60),
    limit: int = Query(200, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """管理员全局安全事件视图；仅返回脱敏字段，不接受正文或来源明文筛选。"""
    from app.models import SecurityEvent

    conditions = [SecurityEvent.occurred_at >= now_utc() - timedelta(minutes=since_minutes)]
    if event_type:
        conditions.append(SecurityEvent.event_type == event_type[:80])
    if action:
        conditions.append(SecurityEvent.action == action[:32])
    if resource_type:
        conditions.append(SecurityEvent.resource_type == resource_type[:120])
    if user_id:
        conditions.append(SecurityEvent.user_id == user_id)
    rows = (await db.execute(
        select(SecurityEvent).where(and_(*conditions))
        .order_by(desc(SecurityEvent.occurred_at)).limit(limit)
    )).scalars().all()
    return {"items": [{
        "id": row.id,
        "user_id": str(row.user_id),
        "event_type": row.event_type,
        "resource_type": row.resource_type,
        "resource_fingerprint": row.resource_fingerprint,
        "owner_fingerprint": row.owner_fingerprint,
        "client_fingerprint": row.client_fingerprint,
        "ip_fingerprint": row.ip_fingerprint,
        "user_agent_fingerprint": row.user_agent_fingerprint,
        "action": row.action,
        "reason_code": row.reason_code,
        "occurred_at": row.occurred_at.isoformat(),
    } for row in rows], "total": len(rows), "since_minutes": since_minutes}


@router.get("")
async def list_audit_logs(
    limit: int = 200,
    db: AsyncSession = Depends(get_db),
):
    rows = await db.execute(
        select(AuditLog).order_by(desc(AuditLog.created_at)).limit(limit)
    )
    items = rows.scalars().all()
    return {
        "items": [
            {
                "id":          r.id,
                "username":    r.username,
                "action":      r.action,
                "description": r.description,
                "ip":          r.ip,
                "created_at":  r.created_at.isoformat(),
            }
            for r in items
        ]
    }


# ── 写入工具函数（供其他模块调用）────────────────────────────────────────────

async def write_log(
    db: AsyncSession,
    username: str,
    action: str,
    description: str,
    request: Request | None = None,
):
    ip = None
    if request:
        forwarded = request.headers.get("X-Forwarded-For")
        ip = forwarded.split(",")[0].strip() if forwarded else request.client.host if request.client else None
    db.add(AuditLog(username=username, action=action, description=description, ip=ip))
    await db.commit()
