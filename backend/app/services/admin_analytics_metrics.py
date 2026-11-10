"""后台分析页的聚合查询。"""
from datetime import datetime

from sqlalchemy import distinct, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User, UserBot


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
    """按本地日期和来源归属交互次数，无会话来源的请求归入 other。"""
    developer_filter = (
        "AND a.user_id NOT IN (SELECT id FROM users WHERE is_developer)"
        if exclude_dev else ""
    )
    byok_filter = "AND NOT a.is_byok" if not include_byok else ""
    rows = (await db.execute(text(f"""
        SELECT DATE(a.created_at AT TIME ZONE {timezone_sql}) AS d,
               CASE WHEN s.source IN ('web', 'qq', 'feishu', 'telegram', 'wechat')
                    THEN s.source ELSE 'other' END AS source,
               COUNT(*)::int AS calls
        FROM agent_usage a
        LEFT JOIN conversation_sessions s ON s.id = a.session_id
        WHERE a.created_at >= :start
          {developer_filter}
          {byok_filter}
        GROUP BY d, source
    """), {"start": start_utc})).all()
    return {(row.d, str(row.source)): int(row.calls) for row in rows}
