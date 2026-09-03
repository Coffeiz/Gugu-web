"""账户与配额查询的 Service 边界。"""

from __future__ import annotations

import json

from sqlalchemy import and_, func, select, update

from app.models import AgentUsage, EmailChangeRequest, User, UserPreferences


async def create_user_preferences(db, user_id, data: dict) -> UserPreferences:
    row = UserPreferences(user_id=user_id, data_json=json.dumps(data, ensure_ascii=False))
    db.add(row)
    await db.flush()
    return row


async def get_user_by_id(db, user_id):
    return await db.get(User, user_id)


async def is_email_occupied(db, email: str, excluding_user_id=None) -> bool:
    statement = select(User.id).where(func.lower(User.email) == email)
    if excluding_user_id is not None:
        statement = statement.where(User.id != excluding_user_id)
    return await db.scalar(statement) is not None


async def get_active_email_change(db, user_id):
    return await db.scalar(select(EmailChangeRequest).where(
        EmailChangeRequest.user_id == user_id,
        EmailChangeRequest.used_at.is_(None),
        EmailChangeRequest.revoked_at.is_(None),
    ))


async def get_email_change_for_token(db, token_hash: str):
    return await db.scalar(select(EmailChangeRequest).where(
        EmailChangeRequest.token_hash == token_hash,
        EmailChangeRequest.purpose == "email_change",
    ).with_for_update())


async def lock_user(db, user_id):
    return await db.scalar(select(User).where(User.id == user_id).with_for_update())


async def revoke_other_email_changes(db, user_id, request_id, revoked_at) -> None:
    await db.execute(update(EmailChangeRequest).where(
        EmailChangeRequest.user_id == user_id,
        EmailChangeRequest.id != request_id,
        EmailChangeRequest.used_at.is_(None),
        EmailChangeRequest.revoked_at.is_(None),
    ).values(revoked_at=revoked_at))


async def usage_sum(db, user_id, since, is_byok: bool) -> int:
    result = await db.execute(select(func.sum(AgentUsage.tokens_in + AgentUsage.tokens_out)).where(
        and_(AgentUsage.user_id == user_id, AgentUsage.created_at >= since, AgentUsage.is_byok.is_(is_byok))
    ))
    return result.scalar() or 0


async def byok_usage_stats(db, user_id, since) -> dict[str, int]:
    # tokens 口径 = 新增输入 + 缓存命中 + 输出（用户面板展示总消耗量）；
    # tokens_in / cache_read 单列保留原始拆分，供缓存命中率计算使用。
    result = await db.execute(select(
        func.coalesce(func.sum(
            AgentUsage.tokens_in + AgentUsage.tokens_out + AgentUsage.cache_read), 0),
        func.coalesce(func.sum(AgentUsage.tokens_in), 0),
        func.coalesce(func.sum(AgentUsage.cache_read), 0),
    ).where(and_(AgentUsage.user_id == user_id, AgentUsage.created_at >= since, AgentUsage.is_byok.is_(True))))
    total, tokens_in, cache_read = result.one()
    return {"tokens": int(total), "tokens_in": int(tokens_in), "cache_read": int(cache_read)}


async def byok_usage_detail(db, user_id, since) -> list[tuple]:
    """近 N 天 BYOK 用量明细行 (created_at, tokens_in, cache_read, cache_write, tokens_out)。

    单用户 30 天的行数有限，取回后按用户本地日聚合，避免依赖数据库时区函数。
    """
    result = await db.execute(select(
        AgentUsage.created_at, AgentUsage.tokens_in,
        AgentUsage.cache_read, AgentUsage.cache_write, AgentUsage.tokens_out,
    ).where(and_(AgentUsage.user_id == user_id, AgentUsage.created_at >= since, AgentUsage.is_byok.is_(True))))
    return list(result.all())
