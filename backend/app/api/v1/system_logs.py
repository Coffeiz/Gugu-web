from fastapi import APIRouter, Depends
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

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
                "created_at": r.created_at.isoformat(),   # 发原始 UTC ISO，前端按查看者浏览器 tz 格式化
            }
            for r in items
        ]
    }
