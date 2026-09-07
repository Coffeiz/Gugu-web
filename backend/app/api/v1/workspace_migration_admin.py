"""旧 Shell 目录迁移盘点的管理员只读入口。"""

from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.services.workspaces import scan_legacy_shell_directories

router = APIRouter(prefix="/admin/workspace-migration", tags=["admin"])


@router.post("/scan")
async def scan_legacy_shell_directories_view(
    user_id: UUID | None = Query(None), db: AsyncSession = Depends(get_db),
):
    reports = await scan_legacy_shell_directories(db, user_id=user_id)
    await db.commit()
    return {
        "items": [
            {
                "id": report.id,
                "user_id": str(report.user_id),
                "status": report.status,
                "source_file_count": report.source_file_count,
                "error_message": report.error_message,
                "scanned_at": report.scanned_at.isoformat(),
            }
            for report in reports
        ],
    }
