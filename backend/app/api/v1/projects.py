import json
import re
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import File, Project, User
from app.schemas import ProjectCreate, ProjectUpdate, ProjectResponse
from app.core.security import get_current_user
from app.services.storage import get_storage

router = APIRouter(prefix="/projects", tags=["projects"])


def _proj_date(p: Project) -> tuple[str, str]:
    """返回 (year, month) 字符串，优先用 start_date，否则用 created_at。"""
    date_str = p.start_date or p.created_at.strftime("%Y-%m-%d")
    return date_str[:4], date_str[5:7]


def _to_resp(p: Project, file_count: int = 0) -> ProjectResponse:
    return ProjectResponse(
        id=p.id,
        name=p.name,
        client=p.client,
        status=p.status,
        start_date=p.start_date,
        deadline=p.deadline,
        color=p.color,
        progress=p.progress,
        stages=p.stages,
        current_stage=p.current_stage,
        archived=p.archived,
        priority=p.priority,
        version=p.version or 1,
        done_at=p.done_at.isoformat() if p.done_at else None,
        updated_at=p.updated_at.isoformat() if p.updated_at else None,
        created_at=p.created_at.strftime("%Y-%m-%d"),
        file_count=file_count,
    )


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 只计根目录文件（folder_id IS NULL），和项目文件视图保持一致；文件夹内文件通过文件夹 UI 展示
    file_count_subq = (
        select(func.count(File.id))
        .where(
            File.deleted_at.is_(None),
            File.project_id == Project.id,
            File.folder_id.is_(None),
        )
        .correlate(Project)
        .scalar_subquery()
    )
    stmt = (
        select(Project, file_count_subq.label("fc"))
        .where(Project.user_id == current_user.id)
        .order_by(Project.created_at.desc())
    )
    result = await db.execute(stmt)
    return [_to_resp(p, fc) for p, fc in result.all()]


@router.post("", response_model=ProjectResponse, status_code=201)
async def create_project(
    body: ProjectCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    p = Project(
        user_id=current_user.id,
        name=body.name,
        client=body.client,
        status=body.status,
        start_date=body.start_date,
        deadline=body.deadline,
        color=body.color,
        progress=body.progress,
        current_stage=body.current_stage,
    )
    p.stages = body.stages
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return _to_resp(p, 0)


@router.get("/{pid}", response_model=ProjectResponse)
async def get_project(
    pid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(Project, func.count(File.id).label("fc"))
        .outerjoin(File, File.project_id == Project.id)
        .where(Project.id == pid, Project.user_id == current_user.id)
        .group_by(Project.id)
    )
    result = await db.execute(stmt)
    row = result.one_or_none()
    if not row:
        raise HTTPException(404, "项目不存在")
    return _to_resp(row[0], row[1])


@router.patch("/{pid}", response_model=ProjectResponse)
async def update_project(
    pid: int,
    body: ProjectUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    p = await db.get(Project, pid)
    if not p or p.user_id != current_user.id:
        raise HTTPException(404, "项目不存在")

    data = body.model_dump(exclude_unset=True, by_alias=False)

    client_version = data.pop("version", None)
    if client_version is not None and p.version != client_version:
        raise HTTPException(409, "数据已被其他用户修改，请刷新后重试")

    # 项目改名时同步重命名存储目录
    old_name = p.name
    new_name = data.get("name")
    if new_name and new_name != old_name:
        def _safe(s: str) -> str:
            return re.sub(r'[\\/:*?"<>|]', "_", s)
        year, month = _proj_date(p)
        old_prefix = f"{p.user_id}/项目文件/{year}/{month}/{_safe(old_name)} #{p.id}"
        new_prefix = f"{p.user_id}/项目文件/{year}/{month}/{_safe(new_name)} #{p.id}"
        storage = get_storage()
        await storage.rename_dir(old_prefix, new_prefix)
        # 批量更新 files.storage_key 前缀
        files_res = await db.execute(
            select(File).where(File.project_id == p.id, File.user_id == p.user_id)
        )
        for f in files_res.scalars().all():
            if f.storage_key.startswith(old_prefix):
                f.storage_key = new_prefix + f.storage_key[len(old_prefix):]

    for k, v in data.items():
        if k == "stages":
            p.stages = v
        else:
            setattr(p, k, v)
    # 仅在 done_at 为空时才记录完成时间，避免拖回已完成列重置时间
    if data.get("status") == "done" and p.done_at is None:
        p.done_at = datetime.utcnow()
    elif "status" in data and data["status"] != "done":
        p.done_at = None

    p.version = (p.version or 1) + 1
    await db.commit()
    await db.refresh(p)

    fc_res = await db.execute(
        select(func.count(File.id)).where(File.project_id == pid, File.user_id == current_user.id, File.deleted_at.is_(None))
    )
    return _to_resp(p, fc_res.scalar_one())


@router.delete("/{pid}", status_code=204)
async def delete_project(
    pid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    p = await db.get(Project, pid)
    if not p or p.user_id != current_user.id:
        raise HTTPException(404, "项目不存在")
    # 连项目内的文件/文件夹一并删除（不再把文件归个人空间）：
    #   · 文件：软删（置 deleted_at），保留物理与「可恢复」语义，与单文件删除一致；
    #   · 文件夹：由 folders.project_id 的 ON DELETE CASCADE 随项目自动删除。
    # 前端在项目有文件/文件夹时已弹确认，这里直接执行级联删除。
    await db.execute(
        update(File)
        .where(File.project_id == pid, File.user_id == current_user.id, File.deleted_at.is_(None))
        .values(deleted_at=datetime.utcnow())
    )
    await db.delete(p)
    await db.commit()
