from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func, distinct, or_, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import User, Project, ConversationSession, AgentUsage, UserBot, FrontendEvent
from app.core.tz import LOCAL_TZ, local_day_start_utc, utc_to_local_date_expr

router = APIRouter(prefix="/admin/analytics", tags=["admin"])


@router.get("/summary")
async def get_summary(db: AsyncSession = Depends(get_db)):
    now = datetime.utcnow()
    d7  = now - timedelta(days=7)
    d30 = now - timedelta(days=30)
    today_start = local_day_start_utc()

    # ── 用户 ──────────────────────────────────────────────────────────────────
    total_users = (await db.execute(
        select(func.count()).select_from(User)
    )).scalar() or 0
    new_7d = (await db.execute(
        select(func.count()).select_from(User).where(User.created_at >= d7)
    )).scalar() or 0
    new_30d = (await db.execute(
        select(func.count()).select_from(User).where(User.created_at >= d30)
    )).scalar() or 0
    active_30d = (await db.execute(
        select(func.count(distinct(AgentUsage.user_id)))
        .where(AgentUsage.created_at >= d30)
    )).scalar() or 0
    # WAU：过去 7 天活跃用户 = 对话过（AgentUsage，覆盖网页 + IM）∪ 登录过网页（last_active_at），按 user_id 去重。
    # IM 走 worker 不更新 last_active_at，靠 AgentUsage 纳入；网页 + IM 都用的同一用户只算一次。
    _chat_ids = set((await db.execute(
        select(distinct(AgentUsage.user_id)).where(AgentUsage.created_at >= d7)
    )).scalars().all())
    _web_ids = set((await db.execute(
        select(User.id).where(User.last_active_at >= d7)
    )).scalars().all())
    wau = len(_chat_ids | _web_ids)

    # ── 项目（排除归档）────────────────────────────────────────────────────────
    total_proj = (await db.execute(
        select(func.count()).select_from(Project).where(Project.archived == False)
    )).scalar() or 0
    pending_proj = (await db.execute(
        select(func.count()).select_from(Project)
        .where(Project.status == "pending", Project.archived == False)
    )).scalar() or 0
    active_proj = (await db.execute(
        select(func.count()).select_from(Project)
        .where(Project.status == "active", Project.archived == False)
    )).scalar() or 0
    done_proj = (await db.execute(
        select(func.count()).select_from(Project)
        .where(Project.status == "done", Project.archived == False)
    )).scalar() or 0

    # ── 对话 ──────────────────────────────────────────────────────────────────
    total_sess = (await db.execute(
        select(func.count()).select_from(ConversationSession)
    )).scalar() or 0
    web_sess = (await db.execute(
        select(func.count()).select_from(ConversationSession)
        .where(or_(ConversationSession.source == "web", ConversationSession.source.is_(None)))
    )).scalar() or 0

    # ── IM Bot ────────────────────────────────────────────────────────────────
    users_with_bot = (await db.execute(
        select(func.count(distinct(UserBot.user_id))).where(UserBot.enabled == True)
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
        return s

    all_row   = (await db.execute(_usage_stmt())).first()
    today_row = (await db.execute(_usage_stmt(AgentUsage.created_at >= today_start))).first()

    # ── 漏斗：每步有过该行为的去重用户数 ───────────────────────────────────────
    users_with_proj = (await db.execute(
        select(func.count(distinct(Project.user_id))).where(Project.archived == False)
    )).scalar() or 0
    users_completed = (await db.execute(
        select(func.count(distinct(Project.user_id))).where(Project.status == "done")
    )).scalar() or 0

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
            "registered":       total_users,
            "created_project":  users_with_proj,
            "completed_project": users_completed,
        },
    }


@router.get("/trends")
async def get_trends(days: int = Query(default=30, ge=7, le=90), db: AsyncSession = Depends(get_db)):
    now_local = datetime.now(LOCAL_TZ)
    start_local = (now_local - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    start_utc = start_local.astimezone(timezone.utc).replace(tzinfo=None)
    local_date_list = [(start_local + timedelta(days=i)).date() for i in range(days)]
    labels = [(start_local + timedelta(days=i)).strftime("%-m/%-d") for i in range(days)]

    tz_expr = utc_to_local_date_expr()   # e.g. INTERVAL '+8 hours'
    agent_rows = (await db.execute(text(f"""
        SELECT DATE(created_at + {tz_expr}) AS d,
               COUNT(*)::int AS calls,
               COALESCE(SUM(tokens_in + tokens_out), 0)::bigint AS tokens
        FROM agent_usage
        WHERE created_at >= :start
        GROUP BY DATE(created_at + {tz_expr})
    """), {"start": start_utc})).all()
    agent_map = {r.d: (r.calls, int(r.tokens)) for r in agent_rows}

    user_rows = (await db.execute(text(f"""
        SELECT DATE(created_at + {tz_expr}) AS d, COUNT(*)::int AS cnt
        FROM users
        WHERE created_at >= :start
        GROUP BY DATE(created_at + {tz_expr})
    """), {"start": start_utc})).all()
    user_map = {r.d: r.cnt for r in user_rows}

    proj_rows = (await db.execute(text(f"""
        SELECT DATE(done_at + {tz_expr}) AS d, COUNT(*)::int AS cnt
        FROM projects
        WHERE done_at IS NOT NULL AND done_at >= :start
        GROUP BY DATE(done_at + {tz_expr})
    """), {"start": start_utc})).all()
    proj_map = {r.d: r.cnt for r in proj_rows}

    return {
        "labels":              labels,
        "agent_calls":         [agent_map.get(d, (0, 0))[0] for d in local_date_list],
        "agent_tokens":        [agent_map.get(d, (0, 0))[1] for d in local_date_list],
        "user_registrations":  [user_map.get(d, 0) for d in local_date_list],
        "project_completions": [proj_map.get(d, 0) for d in local_date_list],
    }


@router.get("/chat-funnel")
async def get_chat_funnel(db: AsyncSession = Depends(get_db)):
    """咕咕对话框行为漏斗：打开 → 发消息 → 第 3 轮。"""
    def _evt(event: str):
        return select(func.count(distinct(FrontendEvent.user_id))).where(
            FrontendEvent.event == event
        )

    opened   = (await db.execute(_evt("chat_open"))).scalar() or 0
    msg1     = (await db.execute(_evt("chat_message"))).scalar() or 0
    expanded = (await db.execute(_evt("chat_expanded"))).scalar() or 0

    # turn >= 3：properties->>'turn' 转 int 比较（PostgreSQL jsonb）
    msg3 = (await db.execute(text("""
        SELECT COUNT(DISTINCT user_id)
        FROM frontend_events
        WHERE event = 'chat_message'
          AND (properties->>'turn')::int >= 3
    """))).scalar() or 0

    return {
        "chat_opened":   opened,
        "chat_msg_1":    msg1,
        "chat_msg_3":    int(msg3),
        "chat_expanded": expanded,
    }


@router.get("/tool-distribution")
async def get_tool_distribution(db: AsyncSession = Depends(get_db)):
    """工具调用频次分布（按工具名聚合，降序 Top 20）。"""
    rows = (await db.execute(text("""
        SELECT elem AS tool_name, COUNT(*)::int AS calls
        FROM agent_usage,
             jsonb_array_elements_text(tools_used::jsonb) AS elem
        WHERE tools_used IS NOT NULL
          AND jsonb_typeof(tools_used::jsonb) = 'array'
        GROUP BY elem
        ORDER BY calls DESC
        LIMIT 20
    """))).all()
    return [{"tool": r.tool_name, "calls": r.calls} for r in rows]
