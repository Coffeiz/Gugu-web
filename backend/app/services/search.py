"""全局搜索数据查询、配额与用量写入边界。"""
from sqlalchemy import case, func, or_, select

from app.models import ScheduledTask, SearchUsage, User, UserMcpServer
from app.search.query import keyword_condition, keyword_score


def _primary_rank(column, query: str):
    normalized = query.lower()
    return case(
        (func.lower(column) == normalized, 0),
        (func.lower(column).like(f"{normalized}%"), 1),
        else_=2,
    )


async def search_global_mcp_servers(db, user_id, queries, mode, primary_query, limit):
    """查询当前用户可见的 MCP 名称，不返回 endpoint 或凭据。"""
    return (await db.execute(
        select(UserMcpServer).where(
            or_(UserMcpServer.user_id == user_id, UserMcpServer.scope == "platform"),
            keyword_condition([UserMcpServer.name], queries, mode),
        ).order_by(
            keyword_score([UserMcpServer.name], queries).desc(),
            _primary_rank(UserMcpServer.name, primary_query),
        ).limit(limit)
    )).scalars().all()


async def search_global_scheduled_tasks(db, user_id, queries, mode, primary_query, limit):
    """查询当前用户启用且未结束的定时任务。"""
    return (await db.execute(
        select(ScheduledTask).where(
            ScheduledTask.user_id == user_id,
            ScheduledTask.enabled.is_(True),
            or_(ScheduledTask.end_at.is_(None), ScheduledTask.end_at > func.now()),
            keyword_condition([ScheduledTask.name], queries, mode),
        ).order_by(
            keyword_score([ScheduledTask.name], queries).desc(),
            _primary_rank(ScheduledTask.name, primary_query),
            ScheduledTask.updated_at.desc(),
        ).limit(limit)
    )).scalars().all()


async def get_user_daily_search_limit(db, user_id):
    user = await db.get(User, user_id)
    return user.search_limit_daily if user and user.search_limit_daily is not None else None


async def count_daily_search_usage(db, user_id, day_start):
    return (await db.execute(select(func.count(SearchUsage.id)).where(
        SearchUsage.user_id == user_id, SearchUsage.created_at >= day_start,
    ))).scalar() or 0


async def record_search_usage(db, user_id, query, *, commit=False):
    db.add(SearchUsage(user_id=user_id, query=query[:500]))
    if commit:
        await db.commit()
    else:
        await db.flush()


SIMILAR_IMAGE_USAGE_PREFIX = "[similar-image]"


async def count_similar_image_usage(db, user_id, day_start):
    """统计相似图搜索用量，与普通文本搜索配额分开。"""
    return (await db.execute(select(func.count(SearchUsage.id)).where(
        SearchUsage.user_id == user_id,
        SearchUsage.created_at >= day_start,
        SearchUsage.query.like(f"{SIMILAR_IMAGE_USAGE_PREFIX}%"),
    ))).scalar() or 0


async def record_similar_image_usage(db, user_id, *, commit=False):
    db.add(SearchUsage(user_id=user_id, query=SIMILAR_IMAGE_USAGE_PREFIX))
    if commit:
        await db.commit()
    else:
        await db.flush()
