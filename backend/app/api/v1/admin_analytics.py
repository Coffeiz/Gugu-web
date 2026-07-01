from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func, distinct, or_, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import (
    User, Project, ConversationSession, AgentUsage, UserBot, FrontendEvent,
    CalendarEvent, File, ScheduledTask,
)
from app.core.tz import LOCAL_TZ, local_day_start_utc, utc_to_local_date_expr

router = APIRouter(prefix="/admin/analytics", tags=["admin"])

# ── 排除开发者（exclude_dev=true 时生效）─────────────────────────────────────
# ORM 查询：user_id 列 .notin_(_DEV_SQ)；users 表自身直接 is_developer == False。
# text SQL：拼 _DEV_NOT_IN（无用户输入，安全）。
_DEV_SQ = select(User.id).where(User.is_developer == True)
_DEV_NOT_IN = " AND user_id NOT IN (SELECT id FROM users WHERE is_developer) "


def _xd(stmt, col, exclude: bool):
    """exclude_dev 时给 ORM 查询追加「user_id 不是开发者」过滤。"""
    return stmt.where(col.notin_(_DEV_SQ)) if exclude else stmt


@router.get("/summary")
async def get_summary(exclude_dev: bool = Query(False), db: AsyncSession = Depends(get_db)):
    now = datetime.utcnow()
    d7  = now - timedelta(days=7)
    d30 = now - timedelta(days=30)
    today_start = local_day_start_utc()
    xd = exclude_dev

    def _users_stmt():
        s = select(func.count()).select_from(User)
        return s.where(User.is_developer == False) if xd else s

    # ── 用户 ──────────────────────────────────────────────────────────────────
    total_users = (await db.execute(_users_stmt())).scalar() or 0
    new_7d = (await db.execute(
        _users_stmt().where(User.created_at >= d7)
    )).scalar() or 0
    new_30d = (await db.execute(
        _users_stmt().where(User.created_at >= d30)
    )).scalar() or 0
    active_30d = (await db.execute(_xd(
        select(func.count(distinct(AgentUsage.user_id)))
        .where(AgentUsage.created_at >= d30), AgentUsage.user_id, xd)
    )).scalar() or 0
    # WAU：过去 7 天活跃用户 = 对话过（AgentUsage，覆盖网页 + IM）∪ 登录过网页（last_active_at），按 user_id 去重。
    # IM 走 worker 不更新 last_active_at，靠 AgentUsage 纳入；网页 + IM 都用的同一用户只算一次。
    _chat_ids = set((await db.execute(_xd(
        select(distinct(AgentUsage.user_id)).where(AgentUsage.created_at >= d7),
        AgentUsage.user_id, xd)
    )).scalars().all())
    _web_stmt = select(User.id).where(User.last_active_at >= d7)
    if xd:
        _web_stmt = _web_stmt.where(User.is_developer == False)
    _web_ids = set((await db.execute(_web_stmt)).scalars().all())
    wau = len(_chat_ids | _web_ids)

    # ── 项目（排除归档）────────────────────────────────────────────────────────
    def _proj_stmt(*where):
        s = select(func.count()).select_from(Project).where(Project.archived == False, *where)
        return _xd(s, Project.user_id, xd)

    total_proj   = (await db.execute(_proj_stmt())).scalar() or 0
    pending_proj = (await db.execute(_proj_stmt(Project.status == "pending"))).scalar() or 0
    active_proj  = (await db.execute(_proj_stmt(Project.status == "active"))).scalar() or 0
    done_proj    = (await db.execute(_proj_stmt(Project.status == "done"))).scalar() or 0

    # ── 对话 ──────────────────────────────────────────────────────────────────
    total_sess = (await db.execute(_xd(
        select(func.count()).select_from(ConversationSession), ConversationSession.user_id, xd)
    )).scalar() or 0
    web_sess = (await db.execute(_xd(
        select(func.count()).select_from(ConversationSession)
        .where(or_(ConversationSession.source == "web", ConversationSession.source.is_(None))),
        ConversationSession.user_id, xd)
    )).scalar() or 0

    # ── IM Bot ────────────────────────────────────────────────────────────────
    users_with_bot = (await db.execute(_xd(
        select(func.count(distinct(UserBot.user_id))).where(UserBot.enabled == True),
        UserBot.user_id, xd)
    )).scalar() or 0

    # ── Agent 用量 ─────────────────────────────────────────────────────────────
    def _usage_stmt(where=None):
        s = select(
            func.count().label("calls"),
            func.coalesce(func.sum(AgentUsage.tokens_in), 0).label("tokens_in"),
            func.coalesce(func.sum(AgentUsage.tokens_out), 0).label("tokens_out"),
        ).select_from(AgentUsage)
        if where is not None:
            s = s.where(where)
        return _xd(s, AgentUsage.user_id, xd)

    all_row   = (await db.execute(_usage_stmt())).first()
    today_row = (await db.execute(_usage_stmt(AgentUsage.created_at >= today_start))).first()

    # ── 留存率：注册超过 N 天的用户中，过去 N 天仍有活跃的比例 ─────────────────────
    cohort_7d  = (await db.execute(_users_stmt().where(User.created_at < d7))).scalar() or 0
    cohort_30d = (await db.execute(_users_stmt().where(User.created_at < d30))).scalar() or 0

    async def _retained(d):
        chat_s = (select(distinct(AgentUsage.user_id))
                  .join(User, AgentUsage.user_id == User.id)
                  .where(AgentUsage.created_at >= d, User.created_at < d))
        web_s = select(User.id).where(User.last_active_at >= d, User.created_at < d)
        if xd:
            chat_s = chat_s.where(User.is_developer == False)
            web_s = web_s.where(User.is_developer == False)
        chat = set((await db.execute(chat_s)).scalars().all())
        web = set((await db.execute(web_s)).scalars().all())
        return len(chat | web)

    retained_7d  = await _retained(d7)
    retained_30d = await _retained(d30)
    retention_7d  = round(retained_7d  / cohort_7d,  4) if cohort_7d  else 0
    retention_30d = round(retained_30d / cohort_30d, 4) if cohort_30d else 0

    # ── 漏斗：每步有过该行为的去重用户数 ───────────────────────────────────────
    users_with_proj = (await db.execute(_xd(
        select(func.count(distinct(Project.user_id))).where(Project.archived == False),
        Project.user_id, xd)
    )).scalar() or 0
    users_completed = (await db.execute(_xd(
        select(func.count(distinct(Project.user_id))).where(Project.status == "done"),
        Project.user_id, xd)
    )).scalar() or 0

    # ── 留存数值指标（wishlist）────────────────────────────────────────────────
    # 创建过第 2 个项目的人数（重复创建行为，含归档——建过就算行为发生）
    _multi_sq = (select(Project.user_id)
                 .group_by(Project.user_id)
                 .having(func.count(Project.id) >= 2)).subquery()
    _multi_stmt = select(func.count()).select_from(_multi_sq)
    if xd:
        _multi_stmt = select(func.count()).select_from(
            select(Project.user_id)
            .where(Project.user_id.notin_(_DEV_SQ))
            .group_by(Project.user_id)
            .having(func.count(Project.id) >= 2).subquery())
    second_project_users = (await db.execute(_multi_stmt)).scalar() or 0

    # 注册满一周、当前仍有进行中项目的人数（项目留存）
    _wk_stmt = (select(func.count(distinct(Project.user_id)))
                .join(User, Project.user_id == User.id)
                .where(Project.status == "active", Project.archived == False,
                       User.created_at < d7))
    if xd:
        _wk_stmt = _wk_stmt.where(User.is_developer == False)
    week_active_project_users = (await db.execute(_wk_stmt)).scalar() or 0

    return {
        "users": {
            "total":      total_users,
            "wau":        wau,
            "active_30d": active_30d,
            "new_7d":     new_7d,
            "new_30d":    new_30d,
        },
        "projects": {
            "total":   total_proj,
            "pending": pending_proj,
            "active":  active_proj,
            "done":    done_proj,
        },
        "sessions": {
            "total": total_sess,
            "web":   web_sess,
            "im":    total_sess - web_sess,
        },
        "im_bots": {
            "users_with_bot": users_with_bot,
            "adoption_rate":  round(users_with_bot / total_users, 4) if total_users else 0,
        },
        "agent": {
            "total_calls":    all_row.calls     if all_row else 0,
            "tokens_in":      all_row.tokens_in if all_row else 0,
            "tokens_out":     all_row.tokens_out if all_row else 0,
            "today_calls":    today_row.calls     if today_row else 0,
            "today_tokens_in":  today_row.tokens_in  if today_row else 0,
            "today_tokens_out": today_row.tokens_out if today_row else 0,
        },
        "funnel": {
            "registered":        total_users,
            "created_project":   users_with_proj,
            "completed_project": users_completed,
            "retention_7d":      retention_7d,    # 0.0–1.0
            "retention_30d":     retention_30d,
            "retained_7d":       retained_7d,     # 留存人数（便于前端展示分子/分母）
            "retained_30d":      retained_30d,
            "cohort_7d":         cohort_7d,       # 分母
            "cohort_30d":        cohort_30d,
        },
        "retention_metrics": {                    # 留存数值指标（wishlist）
            "created_project_users": users_with_proj,        # 创建过项目的人数（去重）
            "second_project_users":  second_project_users,   # 创建过第 2 个项目的人数
            "week_active_project_users": week_active_project_users,  # 注册满一周仍有进行中项目
        },
    }


@router.get("/trends")
async def get_trends(days: int = Query(default=30, ge=7, le=90),
                     exclude_dev: bool = Query(False),
                     db: AsyncSession = Depends(get_db)):
    now_local = datetime.now(LOCAL_TZ)
    start_local = (now_local - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    start_utc = start_local.astimezone(timezone.utc).replace(tzinfo=None)
    local_date_list = [(start_local + timedelta(days=i)).date() for i in range(days)]
    labels = [(start_local + timedelta(days=i)).strftime("%-m/%-d") for i in range(days)]

    tz_expr = utc_to_local_date_expr()   # e.g. INTERVAL '+8 hours'
    nd = _DEV_NOT_IN if exclude_dev else ""

    agent_rows = (await db.execute(text(f"""
        SELECT DATE(created_at + {tz_expr}) AS d,
               COUNT(*)::int AS calls,
               COALESCE(SUM(tokens_in + tokens_out), 0)::bigint AS tokens
        FROM agent_usage
        WHERE created_at >= :start {nd}
        GROUP BY DATE(created_at + {tz_expr})
    """), {"start": start_utc})).all()
    agent_map = {r.d: (r.calls, int(r.tokens)) for r in agent_rows}

    _u_dev = " AND NOT is_developer " if exclude_dev else ""
    user_rows = (await db.execute(text(f"""
        SELECT DATE(created_at + {tz_expr}) AS d, COUNT(*)::int AS cnt
        FROM users
        WHERE created_at >= :start {_u_dev}
        GROUP BY DATE(created_at + {tz_expr})
    """), {"start": start_utc})).all()
    user_map = {r.d: r.cnt for r in user_rows}

    proj_rows = (await db.execute(text(f"""
        SELECT DATE(done_at + {tz_expr}) AS d, COUNT(*)::int AS cnt
        FROM projects
        WHERE done_at IS NOT NULL AND done_at >= :start {nd}
        GROUP BY DATE(done_at + {tz_expr})
    """), {"start": start_utc})).all()
    proj_map = {r.d: r.cnt for r in proj_rows}

    # 新建项目曲线（wishlist：按日聚合）
    proj_new_rows = (await db.execute(text(f"""
        SELECT DATE(created_at + {tz_expr}) AS d, COUNT(*)::int AS cnt
        FROM projects
        WHERE created_at >= :start {nd}
        GROUP BY DATE(created_at + {tz_expr})
    """), {"start": start_utc})).all()
    proj_new_map = {r.d: r.cnt for r in proj_new_rows}

    # 活跃用户曲线（wishlist：整体活跃趋势，不按维度拆）
    # 口径：当日有对话（agent_usage）或有前端行为（frontend_events）的去重用户。
    active_rows = (await db.execute(text(f"""
        SELECT d, COUNT(DISTINCT uid)::int AS cnt FROM (
            SELECT DATE(created_at + {tz_expr}) AS d, user_id AS uid
            FROM agent_usage WHERE created_at >= :start {nd}
            UNION
            SELECT DATE(created_at + {tz_expr}) AS d, user_id AS uid
            FROM frontend_events WHERE created_at >= :start {nd}
        ) t GROUP BY d
    """), {"start": start_utc})).all()
    active_map = {r.d: r.cnt for r in active_rows}

    return {
        "labels":              labels,
        "agent_calls":         [agent_map.get(d, (0, 0))[0] for d in local_date_list],
        "agent_tokens":        [agent_map.get(d, (0, 0))[1] for d in local_date_list],
        "user_registrations":  [user_map.get(d, 0) for d in local_date_list],
        "project_completions": [proj_map.get(d, 0) for d in local_date_list],
        "project_creations":   [proj_new_map.get(d, 0) for d in local_date_list],
        "active_users":        [active_map.get(d, 0) for d in local_date_list],
    }


@router.get("/chat-funnel")
async def get_chat_funnel(exclude_dev: bool = Query(False), db: AsyncSession = Depends(get_db)):
    """咕咕对话框行为漏斗：打开 → 发消息 → 第 3 轮。"""
    xd = exclude_dev

    def _evt(event: str):
        s = select(func.count(distinct(FrontendEvent.user_id))).where(FrontendEvent.event == event)
        return _xd(s, FrontendEvent.user_id, xd)

    opened   = (await db.execute(_evt("chat_open"))).scalar() or 0
    msg1     = (await db.execute(_evt("chat_message"))).scalar() or 0
    expanded = (await db.execute(_evt("chat_expanded"))).scalar() or 0

    nd = _DEV_NOT_IN if xd else ""
    # turn >= 3：properties->>'turn' 转 int 比较（PostgreSQL jsonb）
    msg3 = (await db.execute(text(f"""
        SELECT COUNT(DISTINCT user_id)
        FROM frontend_events
        WHERE event = 'chat_message'
          AND (properties->>'turn')::int >= 3 {nd}
    """))).scalar() or 0

    return {
        "chat_opened":   opened,
        "chat_msg_1":    msg1,
        "chat_msg_3":    int(msg3),
        "chat_expanded": expanded,
    }


@router.get("/tool-distribution")
async def get_tool_distribution(exclude_dev: bool = Query(False), db: AsyncSession = Depends(get_db)):
    """工具调用频次分布（按工具名聚合，降序 Top 20）。"""
    nd = _DEV_NOT_IN if exclude_dev else ""
    rows = (await db.execute(text(f"""
        SELECT elem AS tool_name, COUNT(*)::int AS calls
        FROM agent_usage,
             jsonb_array_elements_text(tools_used::jsonb) AS elem
        WHERE tools_used IS NOT NULL
          AND jsonb_typeof(tools_used::jsonb) = 'array' {nd}
        GROUP BY elem
        ORDER BY calls DESC
        LIMIT 20
    """))).all()
    return [{"tool": r.tool_name, "calls": r.calls} for r in rows]


@router.get("/session-depth")
async def get_session_depth(exclude_dev: bool = Query(False), db: AsyncSession = Depends(get_db)):
    """会话深度分布：每用户取其历史最深会话的用户消息轮数，分档统计用户数。
    档位：1 / 2–3 / 4–10 / 11–30 / 30+（按用户去重，不然重度用户霸占所有档）。"""
    nd = (" AND s.user_id NOT IN (SELECT id FROM users WHERE is_developer) "
          if exclude_dev else "")
    rows = (await db.execute(text(f"""
        SELECT s.user_id AS uid, MAX(t.turns)::int AS max_turns
        FROM (
            SELECT session_id, COUNT(*) AS turns
            FROM conversation_messages
            WHERE role = 'user'
            GROUP BY session_id
        ) t
        JOIN conversation_sessions s ON s.id = t.session_id
        WHERE 1=1 {nd}
        GROUP BY s.user_id
    """))).all()

    buckets = {"1": 0, "2-3": 0, "4-10": 0, "11-30": 0, "30+": 0}
    for r in rows:
        n = r.max_turns
        if n <= 1:
            buckets["1"] += 1
        elif n <= 3:
            buckets["2-3"] += 1
        elif n <= 10:
            buckets["4-10"] += 1
        elif n <= 30:
            buckets["11-30"] += 1
        else:
            buckets["30+"] += 1
    return {"buckets": [{"label": k, "users": v} for k, v in buckets.items()],
            "total_users": len(rows)}


@router.get("/active-dimensions")
async def get_active_dimensions(exclude_dev: bool = Query(False), db: AsyncSession = Depends(get_db)):
    """周活跃维度（近 7 天，去重用户数）。口径 v1 = 「操作过」（服务器有记录的创建/更新/触发），
    纯浏览（查看）未埋点、不含——见 docs/design-admin.md 面板备注。"""
    d7 = datetime.utcnow() - timedelta(days=7)
    xd = exclude_dev

    async def _cnt(col, *where):
        s = select(func.count(distinct(col))).where(*where)
        return (await db.execute(_xd(s, col, xd))).scalar() or 0

    chat     = await _cnt(AgentUsage.user_id, AgentUsage.created_at >= d7)
    project  = await _cnt(Project.user_id, Project.updated_at >= d7)
    calendar = await _cnt(CalendarEvent.user_id, CalendarEvent.created_at >= d7)
    file_    = await _cnt(File.user_id, File.updated_at >= d7, File.deleted_at.is_(None))
    reminder = await _cnt(ScheduledTask.user_id, ScheduledTask.last_run_at >= d7)

    return {"window_days": 7, "dimensions": [
        {"key": "chat",     "label": "聊天用户", "users": chat},
        {"key": "project",  "label": "项目用户", "users": project},
        {"key": "calendar", "label": "日历用户", "users": calendar},
        {"key": "file",     "label": "文件用户", "users": file_},
        {"key": "reminder", "label": "提醒用户", "users": reminder},
    ]}
