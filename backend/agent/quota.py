"""精力（Token 配额）的窗口计算与「封顶 / 满额冻结」记账。

按 6h 剩余额度给每轮 token 封顶（`cap_usage`）：单轮对话再长，也只记到填满 6h 上限为止，
超出部分（对话后半段）丢弃——精力条最多 100%、不会越线。6h 一旦填满，本轮及之后的 token
都不再写入 `AgentUsage`（=冻结），于是 6h 与**周**窗口都不再累加（周同按 `AgentUsage` 求和），
直到 6h 窗口整点重置自然解冻。web 流式 / runner 非流式（IM、定时任务）两处记账共用此处，口径一致。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select, func, and_


def six_h_window_start(now: datetime) -> datetime:
    """当前 6h 固定窗口起点（每天 00 / 06 / 12 / 18 UTC 整点，非滑动）。"""
    return now.replace(hour=(now.hour // 6) * 6, minute=0, second=0, microsecond=0)


async def cap_usage(db, user_id, settings, tin: int, tout: int) -> tuple[int, int]:
    """按 6h 剩余额度给本轮 token **封顶**，返回实际应记账的 `(tin, tout)`。

    精力条最多到 100%：本轮（哪怕单轮对话很长）若会把 6h 用量顶过上限，只记「填满到
    上限」的部分，超出（对话后半段）的 token 既不计 6h 也不计周（周同按 `AgentUsage` 求和）。
    - 6h 已满 → 返回 `(0, 0)`，记账侧据此不写 `AgentUsage`（=冻结）；
    - 无上限（未设且全局默认 None）→ 原样返回。
    """
    from app.models import User, AgentUsage

    u = await db.get(User, user_id)
    if u is None:
        return tin, tout
    limit = u.token_limit_6h or settings.quota.default_token_limit_6h
    if limit is None:
        return tin, tout
    win = six_h_window_start(datetime.utcnow())
    used = (await db.execute(
        select(func.sum(AgentUsage.tokens_in + AgentUsage.tokens_out))
        .where(and_(AgentUsage.user_id == user_id, AgentUsage.created_at >= win))
    )).scalar() or 0
    remaining = limit - used
    if remaining <= 0:
        return 0, 0                      # 已满：本轮一律不计（冻结）
    total = tin + tout
    if total <= remaining:
        return tin, tout                 # 没顶过线：原样计
    ratio = remaining / total            # 顶过线：按比例缩到刚好填满，超出丢弃
    return int(tin * ratio), int(tout * ratio)
