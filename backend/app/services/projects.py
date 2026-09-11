"""项目域的 ORM 查询与跨表写入编排。"""
from datetime import timedelta

from sqlalchemy import func, select, or_

from app.core.tz import now_utc
from app.models import CalendarEvent, File, Folder, Project, ScheduledTask
from app.core.ownership import get_owned
from app.services.storage.trash import move_file_to_trash

PROJECT_TRASH_DAYS = 30


def project_trash_cutoff():
    """返回项目回收站的保留边界；边界统一使用 UTC。"""
    return now_utc() - timedelta(days=PROJECT_TRASH_DAYS)


async def list_project_rows(db, user_id, *, archived: bool, deleted: bool = False):
    """查询项目列表及根目录存活文件数；删除列表只保留 30 天内墓碑。"""
    file_count = (
        select(func.count(File.id))
        .where(
            File.deleted_at.is_(None),
            File.project_id == Project.id,
            File.folder_id.is_(None),
        )
        .correlate(Project)
        .scalar_subquery()
    )
    stmt = select(Project, file_count.label("fc")).where(Project.user_id == user_id)
    if deleted:
        stmt = stmt.where(Project.deleted_at.is_not(None), Project.deleted_at > project_trash_cutoff())
    else:
        stmt = stmt.where(Project.archived == archived, Project.deleted_at.is_(None))
    result = await db.execute(stmt.order_by(Project.deleted_at.desc() if deleted else Project.created_at.desc()))
    return result.all()


async def get_project_row(db, user_id, project_id: int):
    """查询当前用户项目及其文件数。"""
    result = await db.execute(
        select(Project, func.count(File.id).label("fc"))
        .outerjoin(File, (File.project_id == Project.id) & File.deleted_at.is_(None))
        .where(Project.id == project_id, Project.user_id == user_id, Project.deleted_at.is_(None))
        .group_by(Project.id)
    )
    return result.one_or_none()


async def add_project(db, project):
    """把已完成领域校验的项目加入事务。"""
    db.add(project)
    await db.flush()


async def count_project_files(db, user_id, project_id: int) -> int:
    return (await db.execute(
        select(func.count(File.id)).where(
            File.project_id == project_id,
            File.user_id == user_id,
            File.deleted_at.is_(None),
        )
    )).scalar_one()




async def list_agent_projects(db, user_id, *, archived: bool):
    return (await db.execute(
        select(Project).where(
            Project.user_id == user_id,
            Project.archived == archived,
            Project.deleted_at.is_(None),
        ).order_by(Project.updated_at.desc())
    )).scalars().all()


async def project_colors(db, user_id):
    return (await db.execute(
        select(Project.color).where(Project.user_id == user_id, Project.deleted_at.is_(None))
    )).scalars().all()


async def find_project_rows(db, user_id, name: str):
    rows = (await db.execute(
        select(Project).where(Project.user_id == user_id, Project.name == name, Project.deleted_at.is_(None))
    )).scalars().all()
    if not rows:
        rows = (await db.execute(
            select(Project).where(Project.user_id == user_id, Project.name.ilike(f"%{name}%"), Project.deleted_at.is_(None))
        )).scalars().all()
    return rows


async def list_active_project_names(db, user_id):
    return (await db.execute(
        select(Project.name).where(Project.user_id == user_id, Project.archived.is_(False), Project.deleted_at.is_(None))
    )).scalars().all()


async def get_user_project(db, user_id, project_id):
    project = await get_owned(db, Project, project_id, user_id)
    return project if project and project.deleted_at is None else None


async def soft_delete_project_full(db, storage, user_id, project, deleted_at):
    """项目完整软删（网页与咕咕工具共用）：文件进回收站，文件夹/活动软删，
    活动联动的定时任务停用，项目行保留 deleted_at（30 天回收站可恢复）。
    全部行使用同一个 deleted_at 时间戳，恢复路由靠它精确圈定本次删除的行。
    返回 (files, folders, calendar_events, tasks) 供撤销快照/事件通知使用。"""
    folders = (await db.execute(
        select(Folder).where(
            Folder.user_id == user_id, Folder.project_id == project.id,
            Folder.deleted_at.is_(None),
        )
    )).scalars().all()
    file_scope = [File.project_id == project.id]
    if folders:
        file_scope.append(File.folder_id.in_([folder.id for folder in folders]))
    files = (await db.execute(
        select(File).where(
            File.user_id == user_id, File.deleted_at.is_(None), or_(*file_scope),
        )
    )).scalars().all()
    calendar_events = (await db.execute(
        select(CalendarEvent).where(
            CalendarEvent.user_id == user_id, CalendarEvent.project_id == project.id,
            CalendarEvent.deleted_at.is_(None),
        )
    )).scalars().all()
    tasks = []
    if calendar_events:
        tasks = (await db.execute(
            select(ScheduledTask).where(
                ScheduledTask.user_id == user_id,
                ScheduledTask.event_id.in_([event.id for event in calendar_events]),
            )
        )).scalars().all()

    for row in files:
        await move_file_to_trash(storage, row)
        row.deleted_at = deleted_at
        row.version = int(row.version or 1) + 1
    for row in folders:
        row.deleted_at = deleted_at
        row.version = int(row.version or 1) + 1
    for row in calendar_events:
        row.deleted_at = deleted_at
        row.version = int(row.version or 1) + 1
    for row in tasks:
        row.enabled = False
    project.deleted_at = deleted_at
    project.version = int(project.version or 1) + 1
    await db.flush()
    return files, folders, calendar_events, tasks
