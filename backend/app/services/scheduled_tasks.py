"""独立定时任务的查询与写入边界。"""
from sqlalchemy import select
from pathlib import PurePosixPath

from app.core.ownership import get_owned
from app.models import ScheduledTask, Workspace


def normalize_script_authorization(value):
    """规整定时任务的精确脚本能力，不保存宿主机路径。"""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("script_authorization 必须是对象")
    root = str(value.get("root") or "").strip().lower()
    interpreter = str(value.get("interpreter") or "").strip().lower()
    path = str(value.get("script_path") or "").strip().replace("\\", "/")
    args = value.get("args") or []
    if root not in {"workspace", "personal", "project"}:
        raise ValueError("script_authorization.root 无效")
    if interpreter not in {"python3", "node", "bash"}:
        raise ValueError("script_authorization.interpreter 仅支持 python3、node、bash")
    parsed = PurePosixPath(path)
    if not path or parsed.is_absolute() or ".." in parsed.parts or "." in parsed.parts:
        raise ValueError("script_authorization.script_path 必须是沙盒内相对路径")
    if len(parsed.parts) > 32 or any(not part or part in {".", ".."} for part in parsed.parts):
        raise ValueError("script_authorization.script_path 无效")
    if not isinstance(args, list) or len(args) > 32 or any(not isinstance(item, str) for item in args):
        raise ValueError("script_authorization.args 必须是最多 32 个字符串的数组")
    return {"root": root, "script_path": parsed.as_posix(), "interpreter": interpreter, "args": args}


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
