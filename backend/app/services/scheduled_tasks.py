"""独立定时任务的查询与写入边界。"""
from sqlalchemy import select

from app.core.ownership import get_owned
from app.models import ScheduledTask, Workspace


async def validate_task_workspace(db, user_id, workspace_id: int | None) -> int | None:
    """校验任务工作区归属；绑定后任务根目录固定为整个 workspace。"""
    if workspace_id is None:
        return None
    workspace = await get_owned(db, Workspace, workspace_id, user_id)
    if workspace is None or not workspace.enabled:
        raise LookupError("工作区不存在或已停用")
    return workspace.id


async def get_task(db, user_id, task_id):
    task = await get_owned(db, ScheduledTask, task_id, user_id)
    return task if task and task.event_id is None else None


async def find_tasks(db, user_id, name):
    rows = (await db.execute(select(ScheduledTask).where(
        ScheduledTask.user_id == user_id, ScheduledTask.event_id.is_(None), ScheduledTask.name == name,
    ))).scalars().all()
    if not rows:
        rows = (await db.execute(select(ScheduledTask).where(
            ScheduledTask.user_id == user_id, ScheduledTask.event_id.is_(None), ScheduledTask.name.ilike(f"%{name}%"),
        ))).scalars().all()
    return rows


async def list_tasks(db, user_id):
    return (await db.execute(select(ScheduledTask).where(
        ScheduledTask.user_id == user_id, ScheduledTask.event_id.is_(None),
    ).order_by(ScheduledTask.id.desc()))).scalars().all()


async def create_task(db, user_id, *, commit=False, **fields):
    task = ScheduledTask(user_id=user_id, **fields)
    db.add(task)
    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(task)
    return task


async def update_task(db, task, fields, *, commit=False):
    for field, value in fields.items():
        setattr(task, field, value)
    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(task)
    return task


async def delete_task(db, task, *, commit=False):
    task_id, name = task.id, task.name
    await db.delete(task)
    if commit:
        await db.commit()
    else:
        await db.flush()
    return task_id, name
