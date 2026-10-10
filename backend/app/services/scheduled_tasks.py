"""独立定时任务的查询与写入边界。"""
from sqlalchemy import select

from app.core.ownership import get_owned
from app.models import ConversationSession, ScheduledTask, UserBot, Workspace


async def validate_task_workspace(db, user_id, workspace_id: int | None) -> int | None:
    """校验任务工作区归属；绑定后任务根目录固定为整个 workspace。"""
    if workspace_id is None:
        return None
    from app.services.workspaces import workspace_shell_supported
    if not workspace_shell_supported():
        raise LookupError("OSS 存储模式不支持 workspace，请使用独立 Shell 沙盒")
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


async def find_qq_group_session(db, user_id, chat_id: str):
    """只在当前用户的 QQ 群会话中解析投递目标。"""
    return (await db.execute(
        select(ConversationSession)
        .where(
            ConversationSession.user_id == user_id,
            ConversationSession.source == "qq",
            ConversationSession.chat_type == "group",
            ConversationSession.chat_id == chat_id,
        )
        .order_by(ConversationSession.id.desc())
    )).scalars().first()


async def list_qq_group_sessions(db, user_id):
    """列出当前用户已出现过的 QQ 群会话，按最近会话优先。"""
    return (await db.execute(
        select(ConversationSession)
        .where(
            ConversationSession.user_id == user_id,
            ConversationSession.source == "qq",
            ConversationSession.chat_type == "group",
            ConversationSession.chat_id.isnot(None),
        )
        .order_by(ConversationSession.id.desc())
    )).scalars().all()


async def list_im_group_sessions(db, user_id, platform: str, bot_id: int | None = None):
    """列出指定用户、平台和 Bot 下可选的群会话。"""
    query = select(ConversationSession).where(
        ConversationSession.user_id == user_id,
        ConversationSession.source == platform,
        ConversationSession.chat_type == "group",
        ConversationSession.chat_id.isnot(None),
    )
    if bot_id is not None:
        query = query.where(ConversationSession.bot_id == str(bot_id))
    return (await db.execute(query.order_by(ConversationSession.id.desc()))).scalars().all()


async def find_im_group_session(db, user_id, platform: str, chat_id: str, bot_id: int | None = None):
    """按用户归属校验 IM 群目标，防止客户端提交其他用户的会话 ID。"""
    query = select(ConversationSession).where(
        ConversationSession.user_id == user_id,
        ConversationSession.source == platform,
        ConversationSession.chat_type == "group",
        ConversationSession.chat_id == chat_id,
    )
    if bot_id is not None:
        query = query.where(ConversationSession.bot_id == str(bot_id))
    return (await db.execute(query.order_by(ConversationSession.id.desc()))).scalars().first()


async def get_enabled_user_bot(db, user_id, platform: str):
    """返回当前用户指定平台最早创建的启用 Bot。"""
    return (await db.execute(
        select(UserBot)
        .where(
            UserBot.user_id == user_id,
            UserBot.platform == platform,
            UserBot.enabled.is_(True),
        )
        .order_by(UserBot.id.asc())
    )).scalars().first()


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
