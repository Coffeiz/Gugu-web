"""精力（Token 配额）的窗口计算与「封顶 / 满额冻结」记账。

按 6h 剩余额度给每轮 token 封顶（`cap_usage`）：单轮对话再长，也只记到填满 6h 上限为止，
超出部分（对话后半段）丢弃——精力条最多 100%、不会越线。6h 一旦填满，本轮及之后的 token
都不再写入 `AgentUsage`（=冻结），于是 6h 与**周**窗口都不再累加（周同按 `AgentUsage` 求和），
直到 6h 窗口整点重置自然解冻。web 流式 / runner 非流式（IM、定时任务）两处记账共用此处，口径一致。
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

from sqlalchemy import select, func, and_

_CST = timezone(timedelta(hours=8))


def six_h_window_start(now: datetime) -> datetime:
    """当前 6h 固定窗口起点（每天 00 / 06 / 12 / 18 CST 整点，非滑动）。返回 UTC naive datetime。"""
    now_cst = now.replace(tzinfo=timezone.utc).astimezone(_CST)
    win_cst = now_cst.replace(hour=(now_cst.hour // 6) * 6, minute=0, second=0, microsecond=0)
    return win_cst.astimezone(timezone.utc).replace(tzinfo=None)


def _week_start(now: datetime) -> datetime:
    """本周一 00:00 CST 起点，返回 UTC naive datetime。"""
    nc = now.replace(tzinfo=timezone.utc).astimezone(_CST)
    wc = (nc - timedelta(days=nc.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return wc.astimezone(timezone.utc).replace(tzinfo=None)


async def is_exhausted(db, user_id, settings) -> bool:
    """6h 或周配额是否已耗尽（used >= limit）。供「耗尽硬拦」判定——与 cap_usage 同窗口口径
    （CST 6h / 周）。web 流式与 runner 非流式（IM、定时任务）共用，保证两路硬拦口径一致。"""
    from app.models import User, AgentUsage
    u = await db.get(User, user_id)
    if u is None:
        return False
    now = datetime.utcnow()

    async def _used(since: datetime) -> int:
        r = await db.execute(
            select(func.sum(AgentUsage.tokens_in + AgentUsage.tokens_out))
            .where(and_(AgentUsage.user_id == user_id, AgentUsage.created_at >= since))
        )
        return r.scalar() or 0

    limit_6h = u.token_limit_6h or settings.quota.default_token_limit_6h
    if limit_6h is not None and await _used(six_h_window_start(now)) >= limit_6h:
        return True
    limit_w = u.token_limit_weekly or settings.quota.default_token_limit_weekly
    if limit_w is not None and await _used(_week_start(now)) >= limit_w:
        return True
    return False


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
    # 顶过线：精确填满剩余额度（tin 优先、余量给 tout）。**不按比例缩**——比例缩的 int()
    # 会在 remaining 很小、token 很大时截断到 0（如 limit=1），导致 used 永远是 0、cap 永远
    # 填不满，硬拦的 used>=limit 永不触发 → 精力 100% 却能一直聊的 bug 根因。
    cap_in = min(tin, remaining)
    cap_out = remaining - cap_in
    return cap_in, cap_out
