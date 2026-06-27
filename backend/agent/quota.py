"""精力（Token 配额）的窗口计算与「满额冻结」判定。

6h 精力达到上限后进入**冻结**：从那一刻起到 6h 窗口整点重置，本轮及之后产生的
Token 用量都**不再写入 `AgentUsage`**——于是 6h 与**周**窗口都不会再累加（周用量同样
按 `AgentUsage` 求和），直到窗口重置自然解冻。判定与记账共用此处，保证 web 流式 /
runner 非流式（IM、定时任务）各路径口径一致。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select, func, and_


def six_h_window_start(now: datetime) -> datetime:
    """当前 6h 固定窗口起点（每天 00 / 06 / 12 / 18 UTC 整点，非滑动）。"""
    return now.replace(hour=(now.hour // 6) * 6, minute=0, second=0, microsecond=0)


async def six_h_exhausted(db, user_id, settings) -> bool:
    """该用户 6h 精力是否已达上限。

    达上限 → 记账侧据此**跳过写入** `AgentUsage`（冻结），不再推高 6h / 周用量。
    无上限（用户未设且全局默认为 None）恒返回 False。
    """
    from app.models import User, AgentUsage

    u = await db.get(User, user_id)
    if u is None:
        return False
    limit = u.token_limit_6h or settings.quota.default_token_limit_6h
    if limit is None:
        return False
    win = six_h_window_start(datetime.utcnow())
    used = (await db.execute(
        select(func.sum(AgentUsage.tokens_in + AgentUsage.tokens_out))
        .where(and_(AgentUsage.user_id == user_id, AgentUsage.created_at >= win))
    )).scalar() or 0
    return used >= limit
