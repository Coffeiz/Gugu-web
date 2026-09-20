"""反思闲置收束的共享时间策略与 Redis 到期队列。"""
from __future__ import annotations

from datetime import datetime, timedelta
import time

from app.core.tz import now_utc


IDLE_WINDOW = timedelta(minutes=15)
IDLE_WINDOW_SECONDS = int(IDLE_WINDOW.total_seconds())
OWNER_IDLE_KEY = "memory:owner-reflection-idle"
GROUP_OWNER_IDLE_KEY = "memory:owner-group-reflection-idle"


def idle_cutoff(now: datetime | None = None) -> datetime:
    """返回统一的闲置截止时间，供数据库游标扫描使用。"""
    return (now or now_utc()) - IDLE_WINDOW


def epoch_seconds(value: datetime | float | int | None = None) -> float:
    if value is None:
        return time.time()
    if isinstance(value, datetime):
        return value.timestamp()
    return float(value)


def idle_due_at(now: datetime | float | int | None = None) -> float:
    """返回 Redis idle zset 中已到期成员应满足的最大活动时间。"""
    return epoch_seconds(now) - IDLE_WINDOW_SECONDS


async def mark_active(redis, key: str, member: str, *, now=None) -> None:
    """记录最近活动时刻；新消息会重置闲置窗口。"""
    await redis.zadd(key, {str(member): epoch_seconds(now)})


async def clear_active(redis, key: str, member: str) -> None:
    await redis.zrem(key, str(member))


async def due_members(redis, key: str, *, now=None, limit: int = 100) -> list[str]:
    rows = await redis.zrangebyscore(
        key, 0, idle_due_at(now), start=0, num=max(1, int(limit)),
    )
    return [row.decode() if isinstance(row, bytes) else str(row) for row in rows]


async def is_due(redis, key: str, member: str, *, now=None) -> bool:
    """在取得队列锁后再次校验，避免并发新消息被旧扫描提前冲刷。"""
    score = await redis.zscore(key, str(member))
    return score is not None and float(score) <= idle_due_at(now)


async def defer(redis, key: str, member: str, *, delay_seconds: int = 300, now=None) -> None:
    """失败后延后重试，避免 worker 每轮扫描都立即重打反思。"""
    due_at = epoch_seconds(now) + max(1, int(delay_seconds))
    await redis.zadd(key, {str(member): due_at - IDLE_WINDOW_SECONDS})
