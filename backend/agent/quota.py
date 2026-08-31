"""精力（Token 配额）的窗口计算与「封顶 / 满额冻结」记账。

按 6h 剩余额度给每轮 token 封顶（`cap_usage`）：单轮对话再长，也只记到填满 6h 上限为止；
启用用户 BYOK LLM 时不占用平台精力配额，也不执行封顶，
超出部分（对话后半段）丢弃——精力条最多 100%、不会越线。6h 一旦填满，本轮及之后的 token
都不再写入 `AgentUsage`（=冻结），于是 6h 与**周**窗口都不再累加（周同按 `AgentUsage` 求和），
6h 窗口按用户首次实际对话懒启动，结束后无对话不自动启动新窗口；下一次对话才开始新的窗口。
web 流式 / runner 非流式（IM、定时任务）两处记账共用此处，口径一致。
"""
from __future__ import annotations
from app.core.tz import now_utc

from datetime import datetime, timezone, timedelta

from sqlalchemy import select, func, and_

from app.core.tz import LOCAL_TZ


async def has_active_byok_llm(db, user_id, settings) -> bool:
    """判断用户是否启用了用户自己的 LLM；BYOK 调用不占用平台精力配额。"""
    if not (getattr(getattr(settings, "byok", None), "enabled", False)
            or getattr(getattr(settings, "ai", None), "deployment_mode", "") == "local"):
        return False
    from app.models import UserProviderCredential
    result = await db.execute(select(UserProviderCredential.id).where(
        UserProviderCredential.user_id == user_id,
        UserProviderCredential.capability == "llm",
        UserProviderCredential.enabled.is_(True),
    ).limit(1))
    return result.scalar_one_or_none() is not None


def six_h_window_start(now: datetime) -> datetime:
    """兼容旧调用的固定窗口计算；实际用户配额使用 ensure_six_h_window。"""
    now_local = now.replace(tzinfo=timezone.utc).astimezone(LOCAL_TZ)
    win_local = now_local.replace(hour=(now_local.hour // 6) * 6, minute=0, second=0, microsecond=0)
    return win_local.astimezone(timezone.utc).replace(tzinfo=None)


def _week_start(now: datetime) -> datetime:
    """本周一 00:00 本地起点，返回 UTC naive datetime。"""
    nl = now.replace(tzinfo=timezone.utc).astimezone(LOCAL_TZ)
    wl = (nl - timedelta(days=nl.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return wl.astimezone(timezone.utc).replace(tzinfo=None)


async def ensure_six_h_window(db, user_id, now: datetime | None = None) -> datetime:
    """按用户首次实际对话懒启动 6h 窗口；窗口过期后下次对话才启动新窗口。"""
    from app.models import User
    now = now or now_utc()
    user = await db.get(User, user_id)
    if user is None:
        return now
    started = user.quota_window_started_at
    if started is None or now >= started + timedelta(hours=6):
        started = now
        user.quota_window_started_at = started
        await db.commit()
    return started


async def _usage_since(db, user_id, since: datetime) -> int:
    from app.models import AgentUsage
    result = await db.execute(
        select(func.sum(AgentUsage.tokens_in + AgentUsage.tokens_out))
        .where(and_(AgentUsage.user_id == user_id, AgentUsage.created_at >= since, AgentUsage.is_byok.is_(False)))
    )
    return result.scalar() or 0


async def is_exhausted(db, user_id, settings) -> bool:
    """6h 或周配额是否已耗尽；6h 窗口按用户对话懒启动。"""
    if await has_active_byok_llm(db, user_id, settings):
        return False
    from app.models import User, AgentUsage
    u = await db.get(User, user_id)
    if u is None:
        return False
    now = now_utc()
    window_start = await ensure_six_h_window(db, user_id, now)

    async def _used(since: datetime) -> int:
        r = await db.execute(
            select(func.sum(AgentUsage.tokens_in + AgentUsage.tokens_out))
            .where(and_(AgentUsage.user_id == user_id, AgentUsage.created_at >= since, AgentUsage.is_byok.is_(False)))
        )
        return r.scalar() or 0

    limit_6h = u.token_limit_6h or settings.quota.default_token_limit_6h
    if limit_6h is not None and await _used(window_start) >= limit_6h:
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
    if await has_active_byok_llm(db, user_id, settings):
        return tin, tout
    from app.models import User, AgentUsage

    u = await db.get(User, user_id)
    if u is None:
        return tin, tout
    limit_6h = u.token_limit_6h or settings.quota.default_token_limit_6h
    if limit_6h is None:
        return tin, tout
    window_start = await ensure_six_h_window(db, user_id)
    remaining = limit_6h - (await _usage_since(db, user_id, window_start))
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
