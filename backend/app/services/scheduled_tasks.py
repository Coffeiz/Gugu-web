"""独立定时任务的查询与写入边界。"""
from sqlalchemy import select

from app.core.ownership import get_owned
from app.models import ScheduledTask


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
