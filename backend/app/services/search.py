"""搜索配额与用量写入边界。"""
from sqlalchemy import func, select

from app.models import SearchUsage, User


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
