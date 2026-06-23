from datetime import datetime, timedelta
from fastapi import APIRouter, Depends
from sqlalchemy import select, func, distinct, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import User, Project, ConversationSession, AgentUsage, UserBot

router = APIRouter(prefix="/admin/analytics", tags=["admin"])


@router.get("/summary")
async def get_summary(db: AsyncSession = Depends(get_db)):
    now = datetime.utcnow()
    d7  = now - timedelta(days=7)
    d30 = now - timedelta(days=30)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

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
    users_used_agent = (await db.execute(
        select(func.count(distinct(AgentUsage.user_id)))
    )).scalar() or 0

    return {
        "users": {
            "total":     total_users,
            "active_30d": active_30d,
            "new_7d":    new_7d,
            "new_30d":   new_30d,
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
            "used_agent":       users_used_agent,
            "connected_im":     users_with_bot,
        },
    }
