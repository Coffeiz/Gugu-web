from datetime import datetime
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.ownership import get_owned
from app.core.projects import build_project, normalize_project_stages_for_read, update_project_atomic
from app.core.security import get_current_user
from app.core.tz import now_utc
from app.db.session import get_db
from app.models import CalendarEvent, File, Folder, Project, ScheduledTask, User  # orm-exempt: 模型引用随本文件遗留查询，Service 收口时一并移除
from app.schemas import ProjectCreate, ProjectResponse, ProjectUpdate
from app.services.storage import get_storage
from app.services.storage.trash import restore_file_storage
from app.services.undo import UndoService
from app.services.undo.domains import domain_ref, domain_state, event_snapshot, project_snapshot, task_snapshot
from app.services.undo.files import file_snapshot, folder_snapshot
from app.services.projects import (
    soft_delete_project_full,
    add_project,
    count_project_files,
    get_project_row,
    list_project_rows,
    project_trash_cutoff,
)

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
        stages=normalize_project_stages_for_read(p.stages),
        current_stage=p.current_stage,
        archived=p.archived,
        priority=p.priority,
        version=p.version or 1,
        done_at=p.done_at.isoformat() if p.done_at else None,
        updated_at=p.updated_at.isoformat() if p.updated_at else None,
        deleted_at=p.deleted_at.isoformat() if p.deleted_at else None,
        created_at=p.created_at.strftime("%Y-%m-%d"),
        file_count=file_count,
    )


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    archived: bool = Query(False, description="true=只看已归档；默认 false=只看未归档（看板/常规视图用）"),
    deleted: bool = Query(False, description="true=只看 30 天保留期内的已删除项目"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if archived and deleted:
        raise HTTPException(400, "archived 和 deleted 不能同时为 true")
    # 只计根目录文件（folder_id IS NULL），和项目文件视图保持一致；文件夹内文件通过文件夹 UI 展示
    return [_to_resp(p, fc) for p, fc in await list_project_rows(
        db, current_user.id, archived=archived, deleted=deleted)]


@router.post("", response_model=ProjectResponse, status_code=201)
async def create_project(
    request: Request,
    body: ProjectCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        p = build_project(current_user.id, body.model_dump(by_alias=False))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    await add_project(db, p)
    await UndoService.record_forward(
        db, user_id=current_user.id,
        context_id=request.headers.get("X-Undo-Context-ID") if request else None,
        resource="projects", action="create",
        target_refs=[{"kind": "project", "id": p.id}],
        before_state=domain_state({}),
        after_state=domain_state({domain_ref("project", p.id): project_snapshot(p)}),
        base_versions={domain_ref("project", p.id): {"version": 0}},
    )
    await db.commit()
    await db.refresh(p)
    response = _to_resp(p, 0)
    await events.publish(current_user.id, "projects", origin=request.headers.get("X-Client-Id"),
                         operation="create", entity_id=p.id, event_payload=response.model_dump(mode="json", by_alias=True))
    return response


@router.get("/{pid}", response_model=ProjectResponse)
async def get_project(
    pid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await get_project_row(db, current_user.id, pid)
    if not row:
        raise HTTPException(404, "项目不存在")
    return _to_resp(row[0], row[1])


@router.patch("/{pid}", response_model=ProjectResponse)
async def update_project(
    pid: int,
    request: Request,
    body: ProjectUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    p = await get_owned(db, Project, pid, current_user.id)
    if not p or p.deleted_at is not None:
        raise HTTPException(404, "项目不存在")

    data = body.model_dump(exclude_unset=True, by_alias=False)

    client_version = data.pop("version", None)
    if client_version is None:
        raise HTTPException(422, "更新项目必须提供 version")
    if not data:
        return _to_resp(p)
    before = project_snapshot(p)

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

    try:
        updated = await update_project_atomic(db, pid, current_user.id, client_version, data, p)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    if not updated:
        await db.rollback()
        raise HTTPException(409, "数据已被其他用户修改，请刷新后重试")
    # update_project_atomic 使用 Core UPDATE；在 asyncpg 下 SQLAlchemy 可能把未参与
    # 更新的标量字段标记为 expired。Undo 快照必须在显式刷新后读取，避免访问
    # p.done_at 等字段时触发隐式 IO，落入 MissingGreenlet 并把已成功的更新报成 500。
    await db.refresh(p)
    await UndoService.record_forward(
        db, user_id=current_user.id,
        context_id=request.headers.get("X-Undo-Context-ID") if request else None,
        resource="projects", action="update",
        target_refs=[{"kind": "project", "id": p.id}],
        before_state=domain_state({domain_ref("project", p.id): before}),
        after_state=domain_state({domain_ref("project", p.id): project_snapshot(p)}),
        base_versions={domain_ref("project", p.id): {"version": before["version"]}},
    )
    await db.commit()
    await db.refresh(p)
    response = _to_resp(p, await count_project_files(db, current_user.id, pid))
    await events.publish(current_user.id, "projects", origin=request.headers.get("X-Client-Id"),
                         operation="update", entity_id=p.id, event_payload=response.model_dump(mode="json", by_alias=True))

    return response


@router.delete("/{pid}", status_code=204)
async def delete_project(
    pid: int,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    p = await get_owned(db, Project, pid, current_user.id)
    if not p or p.deleted_at is not None:
        raise HTTPException(404, "项目不存在")
    folders = (await db.execute(select(Folder).where(  # orm-exempt: 项目关联文件夹读取待 Service 收口（1.1.2 遗留）
        Folder.user_id == current_user.id, Folder.project_id == pid,
        Folder.deleted_at.is_(None),
    ))).scalars().all()
    folder_ids = [folder.id for folder in folders]
    file_scope = [File.project_id == pid]
    if folder_ids:
        file_scope.append(File.folder_id.in_(folder_ids))
    files = (await db.execute(select(File).where(  # orm-exempt: 项目关联文件读取待 Service 收口（1.1.2 遗留）
        File.user_id == current_user.id, File.deleted_at.is_(None), or_(*file_scope),
    ))).scalars().all()
    calendar_events = (await db.execute(select(CalendarEvent).where(  # orm-exempt: 项目关联活动读取待 Service 收口（1.1.2 遗留）
        CalendarEvent.user_id == current_user.id, CalendarEvent.project_id == pid,
        CalendarEvent.deleted_at.is_(None),
    ))).scalars().all()
    event_ids = [event.id for event in calendar_events]
    tasks = []
    if event_ids:
        tasks = (await db.execute(select(ScheduledTask).where(  # orm-exempt: 项目关联任务读取待 Service 收口（1.1.2 遗留）
            ScheduledTask.user_id == current_user.id,
            ScheduledTask.event_id.in_(event_ids),
        ))).scalars().all()

    before_items = {domain_ref("project", p.id): project_snapshot(p)}
    before_items.update({domain_ref("file", row.id): file_snapshot(row) for row in files})
    before_items.update({domain_ref("folder", row.id): folder_snapshot(row) for row in folders})
    before_items.update({domain_ref("event", row.id): event_snapshot(row) for row in calendar_events})
    before_items.update({domain_ref("task", row.id): task_snapshot(row) for row in tasks})

    stamp = now_utc()
    files, folders, calendar_events, tasks = await soft_delete_project_full(
        db, get_storage(), current_user.id, p, stamp,
    )

    after_items = {domain_ref("project", p.id): project_snapshot(p)}
    after_items.update({domain_ref("file", row.id): file_snapshot(row) for row in files})
    after_items.update({domain_ref("folder", row.id): folder_snapshot(row) for row in folders})
    after_items.update({domain_ref("event", row.id): event_snapshot(row) for row in calendar_events})
    after_items.update({domain_ref("task", row.id): task_snapshot(row) for row in tasks})
    await UndoService.record_forward(
        db, user_id=current_user.id,
        context_id=request.headers.get("X-Undo-Context-ID") if request else None,
        resource="projects", action="delete",
        target_refs=[{"kind": ref.split(":", 1)[0], "id": int(ref.split(":", 1)[1])}
                     for ref in after_items],
        before_state=domain_state(before_items), after_state=domain_state(after_items),
        base_versions={ref: {"version": snapshot.get("version", 0)}
                       for ref, snapshot in before_items.items()},
    )
    await db.commit()
    await events.publish(current_user.id, "projects", origin=request.headers.get("X-Client-Id"),
                         operation="delete", entity_id=pid)
    origin = request.headers.get("X-Client-Id") if request else None
    if files or folders:
        await events.publish(current_user.id, "files", origin=origin, operation="delete",
                             entity_ids=[row.id for row in files] + [row.id for row in folders])
    if calendar_events:
        await events.publish(current_user.id, "calendar", origin=origin, operation="delete",
                             entity_ids=[row.id for row in calendar_events])
    if tasks:
        await events.publish(current_user.id, "scheduled_tasks", origin=origin, operation="update",
                             entity_ids=[row.id for row in tasks])


@router.post("/{pid}/restore", response_model=ProjectResponse)
async def restore_project(
    pid: int,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """从项目回收站恢复项目及同一次删除产生的关联资源。"""
    p = await get_owned(db, Project, pid, current_user.id)
    if not p or p.deleted_at is None:
        raise HTTPException(404, "项目不在回收站中")
    if p.deleted_at <= project_trash_cutoff():
        raise HTTPException(410, "项目已超过 30 天保留期")

    deletion_stamp = p.deleted_at
    folders = (await db.execute(select(Folder).where(  # orm-exempt: 项目关联文件夹读取待 Service 收口（1.1.2 遗留）
        Folder.user_id == current_user.id,
        Folder.project_id == pid,
        Folder.deleted_at == deletion_stamp,
    ))).scalars().all()
    folder_ids = [folder.id for folder in folders]
    file_scope = [File.project_id == pid]
    if folder_ids:
        file_scope.append(File.folder_id.in_(folder_ids))
    files = (await db.execute(select(File).where(  # orm-exempt: 项目关联文件读取待 Service 收口（1.1.2 遗留）
        File.user_id == current_user.id,
        File.deleted_at == deletion_stamp,
        or_(*file_scope),
    ))).scalars().all()
    calendar_events = (await db.execute(select(CalendarEvent).where(  # orm-exempt: 项目关联活动读取待 Service 收口（1.1.2 遗留）
        CalendarEvent.user_id == current_user.id,
        CalendarEvent.project_id == pid,
        CalendarEvent.deleted_at == deletion_stamp,
    ))).scalars().all()
    event_ids = [event.id for event in calendar_events]
    tasks = []
    if event_ids:
        tasks = (await db.execute(select(ScheduledTask).where(  # orm-exempt: 项目关联任务读取待 Service 收口（1.1.2 遗留）
            ScheduledTask.user_id == current_user.id,
            ScheduledTask.event_id.in_(event_ids),
        ))).scalars().all()

    # 先恢复项目和逻辑目录，再恢复文件物理路径；这样路径重建能看到完整项目关系。
    p.deleted_at = None
    p.version = int(p.version or 1) + 1
    for row in folders:
        row.deleted_at = None
        row.version = int(row.version or 1) + 1
    for row in files:
        await restore_file_storage(row, get_storage(), db)
        row.deleted_at = None
        row.version = int(row.version or 1) + 1
    for row in calendar_events:
        row.deleted_at = None
        row.version = int(row.version or 1) + 1
    for row in tasks:
        row.enabled = True
    await db.flush()
    await db.commit()
    await db.refresh(p)

    response = _to_resp(p, await count_project_files(db, current_user.id, pid))
    origin = request.headers.get("X-Client-Id")
    await events.publish(current_user.id, "projects", origin=origin, operation="create",
                         entity_id=pid, event_payload=response.model_dump(mode="json", by_alias=True))
    if files or folders:
        await events.publish(current_user.id, "files", origin=origin, operation="create",
                             entity_ids=[row.id for row in files] + [row.id for row in folders])
    if calendar_events:
        await events.publish(current_user.id, "calendar", origin=origin, operation="create",
                             entity_ids=[row.id for row in calendar_events])
    if tasks:
        await events.publish(current_user.id, "scheduled_tasks", origin=origin, operation="update",
                             entity_ids=[row.id for row in tasks])
    return response
