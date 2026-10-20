"""文件夹目录对账后台入口（P1.5）。挂 require_admin（main.py include 时注入）。

- GET  /admin/folder-doctor/scan   ：只读扫描，返回缺失目录/孤儿目录/位置不一致文件报告（不改盘）。
- POST /admin/folder-doctor/repair ：只补缺失目录；孤儿目录和位置不一致文件只报告。

**安全**：repair 在服务端重新扫描、只对服务端计算的列表动作——不接受调用方传入待删/待搬路径。
"""
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.services.storage import get_storage
from app.services.storage import folder_doctor

router = APIRouter(prefix="/admin/folder-doctor", tags=["admin"])


@router.get("/scan")
async def scan_dirs(
    user_id: Optional[UUID] = Query(None, description="限定某用户；省略=全量对账"),
    db: AsyncSession = Depends(get_db),
):
    report = await folder_doctor.scan(db, get_storage(), user_id)
    return report.to_dict()


class RepairRequest(BaseModel):
    user_id: Optional[UUID] = None
    remove_orphans: bool = False   # 人工确认清孤儿目录的开关；缺失目录总是补
    relocate_files: bool = False   # 人工确认搬迁位置不一致文件的开关


@router.post("/repair")
async def repair_dirs(body: RepairRequest, db: AsyncSession = Depends(get_db)):
    if body.remove_orphans or body.relocate_files:
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail="目录对账只补齐缺失目录，不删除目录或搬迁文件")
    report = await folder_doctor.repair(
        db, get_storage(), user_id=body.user_id)
    return report.to_dict()
