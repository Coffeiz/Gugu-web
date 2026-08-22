"""数据读取层：从 DB 取项目 / 事件，从用户 .agent/ 取记忆。

Phase 1：记忆文件尚未实装，`load_memory` 返回全空占位，保证 builder 中
`{summary}{profile}{pattern}{preferences}{memory}{weekly}{daily}` 仍填空串、行为不变。
"""
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.core.tz import now_utc, resolve_tz, today_str
from app.models import CalendarEvent, File, Folder, MindNode, Project, User
from app.services.storage.folders import resolve_folder_path

PERSONAL_FILES_RECENT_LIMIT = 20
PROJECT_CONTEXT_LIMITS = {"pending": 5, "active": 10, "done": 10}
NOTE_CONTEXT_LIMIT = 20


def _project_priority(project) -> int:
    return {"high": 3, "medium": 2, "low": 1}.get(project.priority, 0)


def _project_sort_key(project):
    """与项目页一致：优先级优先，再按各列的业务日期排序。"""
    priority = _project_priority(project)
    if project.status == "done":
        done_ts = project.done_at.timestamp() if project.done_at else 0
        return (-priority, -done_ts, project.id)
    if project.status == "active":
        return (-priority, project.deadline or "", project.id)
    return (-priority, project.start_date or "", project.id)


async def load_projects(db, user_id) -> list:
    """按项目页规则加载有限项目摘要，并预加载项目文件根目录。"""
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.folders))
        .where(Project.user_id == user_id, Project.archived == False)
    )
    grouped = {status: [] for status in PROJECT_CONTEXT_LIMITS}
    for project in result.scalars().all():
        grouped.setdefault(project.status, []).append(project)
    selected = []
    for status in ("pending", "active", "done"):
        ordered = sorted(grouped.get(status, []), key=_project_sort_key)
        selected.extend(ordered[:PROJECT_CONTEXT_LIMITS[status]])
    return selected


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


async def load_recent_notes(db, user_id, days: int = 7, limit: int = NOTE_CONTEXT_LIMIT) -> list[dict]:
    """读取最近一周的普通时间流笔记摘要，不包含画布便签。"""
    since = now_utc() - timedelta(days=max(days, 0))
    result = await db.execute(
        select(MindNode)
        .where(
            MindNode.user_id == user_id,
            MindNode.kind == "note",
            MindNode.deleted_at.is_(None),
            MindNode.captured_at >= since,
        )
        .order_by(MindNode.captured_at.desc(), MindNode.id.desc())
        .limit(min(max(limit, 0), NOTE_CONTEXT_LIMIT))
    )
    return [
        {
            "id": note.id,
            "title": (note.title or "").strip(),
            "content": (note.content_plain or note.content_md or "").strip()[:500],
            "captured_at": note.captured_at,
        }
        for note in result.scalars().all()
    ]


async def load_files_overview(db, user_id, recent: int = PERSONAL_FILES_RECENT_LIMIT) -> dict:
    """个人文件库的轻量概览。

    全局文件上下文只负责个人空间：只列一级目录和最近文件，不把项目文件
    或其它空间的文件重复注入；项目文件由项目上下文按需负责。
    """
    recent_limit = min(max(int(recent), 0), PERSONAL_FILES_RECENT_LIMIT)
    folders = (await db.execute(
        select(Folder).where(
            Folder.user_id == user_id,
            Folder.project_id.is_(None),
            Folder.parent_id.is_(None),
            Folder.deleted_at.is_(None),
        )
    )).scalars().all()
    personal = File.space == "personal"
    total = (await db.execute(
        select(func.count(File.id)).where(
            File.user_id == user_id, personal, File.deleted_at.is_(None)
        )
    )).scalar() or 0
    # 这里只统计个人空间，项目/素材/思维文件由各自上下文负责。
    trash = (await db.execute(
        select(func.count(File.id)).where(
            File.user_id == user_id, personal, File.deleted_at.isnot(None)
        )
    )).scalar() or 0
    folder_counts = dict((await db.execute(
        select(File.folder_id, func.count(File.id))
        .where(
            File.user_id == user_id, personal, File.deleted_at.is_(None),
            File.folder_id.isnot(None),
        )
        .group_by(File.folder_id)
    )).all())
    files = (await db.execute(
        select(File).where(
            File.user_id == user_id, personal, File.deleted_at.is_(None)
        )
        .order_by(File.updated_at.desc()).limit(recent_limit)
    )).scalars().all()
    # 一级目录不需要展开子树；路径解析仅用于保留个人库根目录下的可读路径。
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
            "file_count": folder_counts.get(folder.id, 0),
        })
    return {
        "total": total,
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


async def load_dynamic_memory(user_id) -> dict:
    """读取每轮动态尾部所需的 stance/summary，避免重新加载完整 memory。"""
    from agent.memory import store
    return await store.read_dynamic_memory(user_id)


async def load_im_channels(user_id) -> dict:
    """已连接的 IM 通知渠道（imreach 有记录＝该平台可主动触达）。返回 {qq: bool, feishu: bool}。
    供 builder 注入「通知渠道连接情况」，让咕咕据实判断能否走某 IM 渠道、别瞎让用户绑。"""
    from app.scheduled_tasks import get_imreach
    out = {}
    for ch, plat in (("qq", "qq"), ("feishu", "feishu")):
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
