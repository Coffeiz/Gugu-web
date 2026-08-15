"""项目域的 ORM 查询与跨表写入编排。"""
from sqlalchemy import func, select, update

from app.models import File, Project


async def list_project_rows(db, user_id, *, archived: bool):
    """查询项目列表及根目录存活文件数。"""
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
    result = await db.execute(
        select(Project, file_count.label("fc"))
        .where(Project.user_id == user_id, Project.archived == archived)
        .order_by(Project.created_at.desc())
    )
    return result.all()


async def get_project_row(db, user_id, project_id: int):
    """查询当前用户项目及其文件数。"""
    result = await db.execute(
        select(Project, func.count(File.id).label("fc"))
        .outerjoin(File, File.project_id == Project.id)
        .where(Project.id == project_id, Project.user_id == user_id)
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


async def soft_delete_project_files(db, user_id, project_id: int, deleted_at):
    """将项目内存活文件批量移入回收站。"""
    await db.execute(
        update(File)
        .where(
            File.project_id == project_id,
            File.user_id == user_id,
            File.deleted_at.is_(None),
        )
        .values(deleted_at=deleted_at)
    )
