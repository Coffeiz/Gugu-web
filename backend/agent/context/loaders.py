"""数据读取层：从 DB 取项目 / 事件，从用户 .agent/ 取记忆。

Phase 1：记忆文件尚未实装，`load_memory` 返回全空占位，保证 builder 中
`{summary}{profile}{pattern}{preferences}{memory}{weekly}{daily}` 仍填空串、行为不变。
"""
from datetime import datetime

from sqlalchemy import func, select

from app.core.tz import resolve_tz, today_str
from app.models import CalendarEvent, File, Folder, Project, User
from app.services.storage.folders import resolve_folder_path


async def load_projects(db, user_id) -> list:
    """当前用户未归档项目，按 updated_at 倒序（迁自原 _stream）。"""
    result = await db.execute(
        select(Project)
        .where(Project.user_id == user_id, Project.archived == False)
        .order_by(Project.updated_at.desc())
    )
    return result.scalars().all()


async def load_user_tz(db, user_id):
    """当前用户的时区（tzinfo）：User.timezone 有值就用，否则回退服务器 LOCAL_TZ。
    供 builder / load_events 把「今天」按用户本地日算（见 docs/backend/时区与时钟迁移方案.md Phase 3）。"""
    name = await db.scalar(select(User.timezone).where(User.id == user_id))
    return resolve_tz(name)


async def load_events(db, user_id, limit: int = 10, tz=None) -> list:
    """今天起的近期日历事件（迁自原 _stream）。「今天」按 tz 的本地日算（tz=None 回退服务器 tz）。"""
    today = today_str(tz)
    result = await db.execute(
        select(CalendarEvent)
        .where(CalendarEvent.user_id == user_id, CalendarEvent.date >= today)
        .order_by(CalendarEvent.date).limit(limit)
    )
    return result.scalars().all()


async def load_files_overview(db, user_id, recent: int = 25) -> dict:
    """文件/文件夹概览：文件夹列表 + 各空间文件数 + 最近文件（每轮注入，保证最新）。"""
    folders = (await db.execute(
        select(Folder).where(Folder.user_id == user_id)
    )).scalars().all()
    total = (await db.execute(
        select(func.count(File.id)).where(File.user_id == user_id, File.deleted_at.is_(None))
    )).scalar() or 0
    # 各空间活跃文件数 + 回收站数（每轮注入真值，杜绝模型对"几个文件/删了几个"凭印象瞎报）
    by_space = {
        sp: c for sp, c in (await db.execute(
            select(File.space, func.count(File.id))
            .where(File.user_id == user_id, File.deleted_at.is_(None))
            .group_by(File.space)
        )).all()
    }
    trash = (await db.execute(
        select(func.count(File.id)).where(File.user_id == user_id, File.deleted_at.isnot(None))
    )).scalar() or 0
    files = (await db.execute(
        select(File).where(File.user_id == user_id, File.deleted_at.is_(None))
        .order_by(File.updated_at.desc()).limit(recent)
    )).scalars().all()
    # 文件夹 id→完整路径：给 Agent 看目录树时不能只给叶子名，否则二级目录无法判断归属。
    fmap = {}
    folder_rows = []
    for folder in folders:
        resolved = await resolve_folder_path(db, user_id, folder.id, folder.project_id)
        if not resolved:
            continue
        _, path = resolved
        fmap[folder.id] = path
        folder_rows.append({
            "id": folder.id, "name": folder.name, "path": path,
            "project_id": folder.project_id, "parent_id": folder.parent_id,
        })
    return {
        "total": total,
        "by_space": by_space,
        "trash": trash,
        "folders": folder_rows,
        "files": [
            {"id": f.id, "name": f"{f.display_name}.{f.ext}", "space": f.space,
             "folder": fmap.get(f.folder_id), "project_id": f.project_id}
            for f in files
        ],
    }


async def load_memory(user_id, query: str = "") -> dict:
    """读取用户 .agent/ 记忆，返回 profile/pattern/daily/memory/summary（缺失为空串）。
    query = 当前用户消息（可选）：传入则 pattern 超上限时按相关性优先挑（见 store.render_pattern）。"""
    from agent.memory import store
    return await store.read_memory(user_id, query)


async def load_im_channels(user_id) -> dict:
    """已连接的 IM 通知渠道（imreach 有记录＝该平台可主动触达）。返回 {qq: bool, feishu: bool}。
    供 builder 注入「通知渠道连接情况」，让咕咕据实判断能否走某 IM 渠道、别瞎让用户绑。"""
    from app.scheduled_tasks import get_imreach
    out = {}
    for ch, plat in (("qq", "qqbot"), ("feishu", "feishu")):
        try:
            out[ch] = bool(await get_imreach(user_id, plat))
        except Exception:
            out[ch] = False
    return out


async def load_style_prefs(db, user_id) -> dict:
    """读取用户回复风格偏好（reply_tone / reply_length），缺失键直接省略。
    （emoji 风格不开放给用户选，由 persona 统一管，见 builder._style_block。）"""
    from app.models import UserPreferences
    result = await db.execute(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    )
    prefs = result.scalar_one_or_none()
    if prefs is None:
        return {}
    data = prefs.data
    return {k: data[k] for k in ("reply_tone", "reply_length") if data.get(k)}
