from fastapi import APIRouter, Depends, Request
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import AuditLog

router = APIRouter(prefix="/admin/audit-log", tags=["admin"])


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
