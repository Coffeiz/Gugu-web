"""后台分析页的聚合查询。"""
from datetime import datetime

from sqlalchemy import bindparam, distinct, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User, UserBot


INTERACTION_INPUT_SOURCES = ("web", "qq", "feishu", "telegram", "wechat")


async def enabled_bot_users_by_platform(
    db: AsyncSession, *, exclude_dev: bool,
) -> tuple[int, dict[str, int]]:
    """返回启用 Bot 的去重用户总数及各平台去重用户数。"""
    stmt = select(UserBot.platform, func.count(distinct(UserBot.user_id))).where(
        UserBot.enabled.is_(True),
    ).group_by(UserBot.platform)
    if exclude_dev:
        stmt = stmt.where(UserBot.user_id.not_in(
            select(User.id).where(User.is_developer.is_(True))
        ))
    rows = (await db.execute(stmt)).all()
    by_platform = {str(platform): int(count) for platform, count in rows}
    total_stmt = select(func.count(distinct(UserBot.user_id))).where(UserBot.enabled.is_(True))
    if exclude_dev:
        total_stmt = total_stmt.where(UserBot.user_id.not_in(
            select(User.id).where(User.is_developer.is_(True))
        ))
    total = int((await db.execute(total_stmt)).scalar() or 0)
    return total, by_platform


async def interaction_calls_by_source(
    db: AsyncSession,
    *,
    start_utc: datetime,
    timezone_sql: str,
    exclude_dev: bool,
    include_byok: bool,
) -> dict[tuple[object, str], int]:
    """统计五个入口的主对话，旧账本行使用仍可关联的会话来源。"""
    developer_filter = (
        "AND a.user_id NOT IN (SELECT id FROM users WHERE is_developer)"
        if exclude_dev else ""
    )
    byok_filter = "AND NOT a.is_byok" if not include_byok else ""
    source = "COALESCE(a.input_source, s.source)"
    rows = (await db.execute(text(f"""
        SELECT DATE(a.created_at AT TIME ZONE {timezone_sql}) AS d,
               {source} AS source,
               COUNT(*)::int AS calls
        FROM agent_usage a
        LEFT JOIN conversation_sessions s ON s.id = a.session_id
        WHERE a.created_at >= :start
          AND a.scenario = 'chat'
          AND {source} IN :sources
          {developer_filter}
          {byok_filter}
        GROUP BY d, {source}
    """).bindparams(bindparam("sources", expanding=True)),
        {"start": start_utc, "sources": INTERACTION_INPUT_SOURCES})).all()
    return {(row.d, str(row.source)): int(row.calls) for row in rows}
