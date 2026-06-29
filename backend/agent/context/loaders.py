"""数据读取层：从 DB 取项目 / 事件，从用户 .agent/ 取记忆。

Phase 1：记忆文件尚未实装，`load_memory` 返回全空占位，保证 builder 中
`{summary}{facts}{preferences}{memory}{weekly}{daily}` 仍填空串、行为不变。
"""
from datetime import datetime

from sqlalchemy import func, select

from app.models import CalendarEvent, File, Folder, Project


async def load_projects(db, user_id) -> list:
    """当前用户未归档项目，按 updated_at 倒序（迁自原 _stream）。"""
    result = await db.execute(
        select(Project)
        .where(Project.user_id == user_id, Project.archived == False)
        .order_by(Project.updated_at.desc())
    )
    return result.scalars().all()


async def load_events(db, user_id, limit: int = 10) -> list:
    """今天起的近期日历事件（迁自原 _stream）。"""
    today = datetime.now().strftime("%Y-%m-%d")
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
    # 文件夹 id→name，便于标注文件所属
    fmap = {fo.id: fo.name for fo in folders}
    return {
        "total": total,
        "by_space": by_space,
        "trash": trash,
        "folders": [{"id": fo.id, "name": fo.name, "project_id": fo.project_id} for fo in folders],
        "files": [
            {"id": f.id, "name": f"{f.display_name}.{f.ext}", "space": f.space,
             "folder": fmap.get(f.folder_id), "project_id": f.project_id}
            for f in files
        ],
    }


async def load_memory(user_id) -> dict:
    """读取用户 .agent/ 记忆，返回 {facts, daily, memory, summary}（缺失为空串）。"""
    from agent.memory import store
    return await store.read_memory(user_id)


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
