from fastapi import APIRouter, Depends
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import fmt_local
from app.db.session import get_db
from app.models import SystemLog

router = APIRouter(prefix="/admin/system-logs", tags=["admin"])


@router.get("")
async def list_system_logs(
    limit: int = 200,
    level: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(SystemLog).order_by(desc(SystemLog.created_at)).limit(limit)
    if level:
        stmt = stmt.where(SystemLog.level == level.upper())
    rows = await db.execute(stmt)
    items = rows.scalars().all()
    return {
        "items": [
            {
                "id":         r.id,
                "level":      r.level,
                "module":     r.module,
                "message":    r.message,
                "traceback":  r.traceback,
                "created_at": fmt_local(r.created_at, "%Y-%m-%d %H:%M:%S"),
            }
            for r in items
        ]
    }
