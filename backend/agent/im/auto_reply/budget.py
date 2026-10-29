"""群聊 scored 主动发言槽位的 Redis 原子预留。"""
from __future__ import annotations

from hashlib import sha256
import time


_RESERVE_SCRIPT = """
local key = KEYS[1]
local state_key = KEYS[2]
local run_id = ARGV[1]
local now_ms = tonumber(ARGV[2])
local window_ms = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local min_interval_ms = tonumber(ARGV[5])
local lease_ms = tonumber(ARGV[6])
local existing = redis.call('ZSCORE', key, run_id)
if existing then return 1 end
local expired = redis.call('ZRANGEBYSCORE', key, '-inf', now_ms - window_ms)
for _, old_run_id in ipairs(expired) do
  local old_state = redis.call('HGET', state_key, old_run_id)
  local lease_until = tonumber(redis.call('HGET', state_key, 'lease:' .. old_run_id) or '0')
  if old_state == 'RESERVED' and lease_until > now_ms then
    -- 长任务的有效租约可以超过计数窗口，不能让运行中的同一任务重新取额度。
  else
    if old_state == 'RESERVED' then redis.call('HSET', state_key, old_run_id, 'UNRESOLVED') end
    redis.call('ZREM', key, old_run_id)
  end
end
if redis.call('ZCARD', key) >= limit then return 0 end
local latest = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
if #latest > 0 and now_ms - tonumber(latest[2]) < min_interval_ms then return 0 end
redis.call('ZADD', key, now_ms, run_id)
redis.call('HSET', state_key, run_id, 'RESERVED')
redis.call('HSET', state_key, 'lease:' .. run_id, now_ms + lease_ms)
redis.call('EXPIRE', key, math.ceil(window_ms / 1000) + 120)
redis.call('EXPIRE', state_key, math.ceil(window_ms / 1000) + 120)
return 2
"""

_SETTLE_SCRIPT = """
local key = KEYS[1]
local state_key = KEYS[2]
local run_id = ARGV[1]
local outcome = ARGV[2]
local now_ms = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local state = redis.call('HGET', state_key, run_id)
if not state then return 0 end
if state == 'ACCEPTED' or state == 'RECONCILED_ACCEPTED' then return 1 end
if state == 'RELEASED' then return 0 end
if outcome == 'ACCEPTED' then
  redis.call('ZADD', key, now_ms, run_id)
  redis.call('HSET', state_key, run_id, (state == 'UNKNOWN' or state == 'UNRESOLVED') and 'RECONCILED_ACCEPTED' or 'ACCEPTED')
elseif outcome == 'UNKNOWN' then
  redis.call('ZADD', key, now_ms, run_id)
  redis.call('HSET', state_key, run_id, 'UNKNOWN')
elseif outcome == 'UNRESOLVED' then
  redis.call('ZADD', key, now_ms, run_id)
  redis.call('HSET', state_key, run_id, 'UNRESOLVED')
elseif outcome == 'RECONCILED_FAILED' then
  redis.call('ZREM', key, run_id)
  redis.call('HSET', state_key, run_id, 'RECONCILED_FAILED')
elseif outcome == 'FAILED_CONFIRMED' then
  redis.call('ZREM', key, run_id)
  redis.call('HSET', state_key, run_id, 'RELEASED')
else
  return 0
end
redis.call('HDEL', state_key, 'lease:' .. run_id)
redis.call('EXPIRE', key, ttl)
redis.call('EXPIRE', state_key, ttl)
return 1
"""

_RENEW_SCRIPT = """
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  redis.call('EXPIRE', KEYS[2], ARGV[2])
  redis.call('HSET', KEYS[2], 'lease:' .. ARGV[1], tonumber(ARGV[3]) + tonumber(ARGV[4]))
  return 1
end
return 0
"""

_RESERVE_SOFT_SCRIPT = """
local group_key = KEYS[1]
local sender_key = KEYS[2]
local anchor_key = KEYS[3]
local state_key = KEYS[4]
local run_id = ARGV[1]
local anchor_id = ARGV[2]
local now_ms = tonumber(ARGV[3])
local window_ms = tonumber(ARGV[4])
local sender_interval_ms = tonumber(ARGV[5])
local group_limit = tonumber(ARGV[6])
local ttl_seconds = tonumber(ARGV[7])
local expired = redis.call('ZRANGEBYSCORE', group_key, '-inf', now_ms - window_ms)
for _, old_run_id in ipairs(expired) do
  local old_state = redis.call('HGET', state_key, 'soft:' .. old_run_id)
  local lease_until = tonumber(redis.call('HGET', state_key, 'lease:soft:' .. old_run_id) or '0')
  if old_state == 'RESERVED' and lease_until > now_ms then
    -- 长任务租约有效时保留群级和成员级槽位。
  else
    local old_sender_key = redis.call('HGET', state_key, 'softsender:' .. old_run_id)
    if old_sender_key then redis.call('ZREM', old_sender_key, old_run_id) end
    if old_state == 'RESERVED' then redis.call('HSET', state_key, 'soft:' .. old_run_id, 'UNRESOLVED') end
    redis.call('ZREM', group_key, old_run_id)
  end
end
local existing_group = redis.call('ZSCORE', group_key, run_id)
local existing_sender = redis.call('ZSCORE', sender_key, run_id)
if existing_group and existing_sender then return 1 end
if existing_group or existing_sender then return 0 end
if redis.call('HGET', anchor_key, 'anchor_id') ~= anchor_id then return 0 end
local consumed_by = redis.call('HGET', anchor_key, 'consumed_by')
if consumed_by and consumed_by ~= run_id then return 0 end
redis.call('ZREMRANGEBYSCORE', group_key, '-inf', now_ms - window_ms)
redis.call('ZREMRANGEBYSCORE', sender_key, '-inf', now_ms - window_ms)
if redis.call('ZCARD', group_key) >= group_limit then return 0 end
local latest_sender = redis.call('ZREVRANGE', sender_key, 0, 0, 'WITHSCORES')
if #latest_sender > 0 and now_ms - tonumber(latest_sender[2]) < sender_interval_ms then return 0 end
redis.call('ZADD', group_key, now_ms, run_id)
redis.call('ZADD', sender_key, now_ms, run_id)
redis.call('HSET', anchor_key, 'consumed_by', run_id)
redis.call('HSET', state_key, 'soft:' .. run_id, 'RESERVED')
redis.call('HSET', state_key, 'lease:soft:' .. run_id, now_ms + ttl_seconds * 1000)
redis.call('HSET', state_key, 'softsender:' .. run_id, sender_key)
redis.call('EXPIRE', group_key, ttl_seconds)
redis.call('EXPIRE', sender_key, ttl_seconds)
redis.call('EXPIRE', anchor_key, ttl_seconds)
redis.call('EXPIRE', state_key, ttl_seconds)
return 2
"""

_RENEW_SOFT_SCRIPT = """
if redis.call('ZSCORE', KEYS[1], ARGV[1]) and redis.call('ZSCORE', KEYS[2], ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  redis.call('EXPIRE', KEYS[2], ARGV[2])
  redis.call('EXPIRE', KEYS[3], ARGV[2])
  redis.call('HSET', KEYS[3], 'lease:soft:' .. ARGV[1], tonumber(ARGV[3]) + tonumber(ARGV[4]))
  return 1
end
return 0
"""

_SETTLE_SOFT_SCRIPT = """
local group_key = KEYS[1]
local sender_key = KEYS[2]
local state_key = KEYS[3]
local state_field = 'soft:' .. ARGV[1]
local run_id = ARGV[1]
local outcome = ARGV[2]
local now_ms = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local state = redis.call('HGET', state_key, state_field)
if not state or state == 'RELEASED' then return 0 end
if state == 'ACCEPTED' or state == 'RECONCILED_ACCEPTED' then return 1 end
if outcome == 'FAILED_CONFIRMED' or outcome == 'RECONCILED_FAILED' then
  redis.call('ZREM', group_key, run_id)
  redis.call('ZREM', sender_key, run_id)
  redis.call('HSET', state_key, state_field, outcome == 'RECONCILED_FAILED' and 'RECONCILED_FAILED' or 'RELEASED')
elseif outcome == 'ACCEPTED' then
  redis.call('ZADD', group_key, now_ms, run_id)
  redis.call('ZADD', sender_key, now_ms, run_id)
  redis.call('HSET', state_key, state_field, (state == 'UNKNOWN' or state == 'UNRESOLVED') and 'RECONCILED_ACCEPTED' or 'ACCEPTED')
elseif outcome == 'UNKNOWN' or outcome == 'UNRESOLVED' then
  redis.call('ZADD', group_key, now_ms, run_id)
  redis.call('ZADD', sender_key, now_ms, run_id)
  redis.call('HSET', state_key, state_field, outcome)
else
  return 0
end
redis.call('HDEL', state_key, 'lease:soft:' .. run_id)
redis.call('EXPIRE', group_key, ttl)
redis.call('EXPIRE', sender_key, ttl)
redis.call('EXPIRE', state_key, ttl)
return 1
"""


def _key(platform: str, bot_id: str, group_id: str) -> str:
    digest = sha256(f"{platform}\0{bot_id}\0{group_id}".encode()).hexdigest()
    return f"im:attention:budget:{{{digest}}}"


def _state_key(platform: str, bot_id: str, group_id: str) -> str:
    return f"{_key(platform, bot_id, group_id)}:state"


def _soft_keys(platform: str, bot_id: str, group_id: str, sender_id: str) -> tuple[str, str, str]:
    digest = sha256(f"{platform}\0{bot_id}\0{group_id}".encode()).hexdigest()
    sender_digest = sha256(str(sender_id).encode()).hexdigest()
    root = f"im:attention:soft:{{{digest}}}"
    return f"{root}:group", f"{root}:sender:{sender_digest}", f"{root}:anchor:{sender_digest}"


async def reserve_proactive_slot(redis, *, platform: str, bot_id: str, group_id: str,
                                 run_id: str, mode: str, now_ms: int) -> bool:
    """按模式并发安全预留；相同 run 重试幂等，未知发送状态保持占位。"""
    limits = {"natural": (2, 180_000), "active": (5, 60_000)}
    if mode not in limits or not run_id:
        return False
    limit, interval = limits[mode]
    result = await redis.eval(
        _RESERVE_SCRIPT,
        2,
        _key(platform, bot_id, group_id),
        _state_key(platform, bot_id, group_id),
        run_id,
        int(now_ms),
        600_000,
        limit,
        interval,
        720_000,
    )
    return int(result or 0) in {1, 2}


async def settle_proactive_slot(redis, *, platform: str, bot_id: str, group_id: str,
                                run_id: str, outcome: str, now_ms: int,
                                ttl_seconds: int = 720) -> bool:
    """提交平台发送结果；UNKNOWN 保留有限额度，等待后续对账或转 UNRESOLVED。"""
    result = await redis.eval(
        _SETTLE_SCRIPT,
        2,
        _key(platform, bot_id, group_id),
        _state_key(platform, bot_id, group_id),
        run_id,
        outcome,
        int(now_ms),
        max(120, int(ttl_seconds)),
    )
    return bool(int(result or 0))


async def recent_proactive_acceptances(redis, *, platform: str, bot_id: str,
                                       group_id: str, since_ms: int,
                                       until_ms: int) -> tuple[tuple[str, int], ...]:
    key = _key(platform, bot_id, group_id)
    state_key = _state_key(platform, bot_id, group_id)
    rows = await redis.zrangebyscore(
        key, int(since_ms), int(until_ms), withscores=True,
    )
    facts = []
    for run_id, score in rows:
        state = await redis.hget(state_key, str(run_id))
        if state in {"ACCEPTED", "RECONCILED_ACCEPTED"}:
            facts.append((str(run_id), int(float(score))))
    return tuple(facts)


async def renew_proactive_slot(redis, *, platform: str, bot_id: str, group_id: str,
                               run_id: str, ttl_seconds: int = 720,
                               now_ms: int | None = None) -> bool:
    now_ms = int(now_ms or time.time() * 1000)
    result = await redis.eval(
        _RENEW_SCRIPT,
        2,
        _key(platform, bot_id, group_id),
        _state_key(platform, bot_id, group_id),
        run_id,
        max(120, int(ttl_seconds)),
        now_ms,
        max(120, int(ttl_seconds)) * 1000,
    )
    return bool(int(result or 0))


async def release_proactive_slot(redis, *, platform: str, bot_id: str, group_id: str,
                                 run_id: str) -> None:
    if run_id:
        await settle_proactive_slot(
            redis, platform=platform, bot_id=bot_id, group_id=group_id,
            run_id=run_id, outcome="FAILED_CONFIRMED", now_ms=0,
        )


async def register_soft_anchor(redis, *, platform: str, bot_id: str, group_id: str,
                               sender_id: str, anchor_id: str, ttl_seconds: int = 90) -> bool:
    if not all((platform, bot_id, group_id, sender_id, anchor_id)):
        return False
    _, _, key = _soft_keys(platform, bot_id, group_id, sender_id)
    await redis.hset(key, mapping={"anchor_id": anchor_id})
    await redis.hdel(key, "consumed_by")
    await redis.expire(key, max(1, int(ttl_seconds)))
    return True


async def get_soft_anchor(redis, *, platform: str, bot_id: str, group_id: str,
                          sender_id: str) -> str | None:
    if not sender_id:
        return None
    _, _, key = _soft_keys(platform, bot_id, group_id, sender_id)
    values = await redis.hmget(key, "anchor_id", "consumed_by")
    if not values or not values[0] or values[1]:
        return None
    return str(values[0])


async def reserve_soft_slot(redis, *, platform: str, bot_id: str, group_id: str,
                            sender_id: str, run_id: str, anchor_id: str,
                            now_ms: int) -> bool:
    if not all((platform, bot_id, group_id, sender_id, run_id, anchor_id)):
        return False
    group_key, sender_key, anchor_key = _soft_keys(platform, bot_id, group_id, sender_id)
    result = await redis.eval(
        _RESERVE_SOFT_SCRIPT,
        4,
        group_key,
        sender_key,
        anchor_key,
        _state_key(platform, bot_id, group_id),
        run_id,
        anchor_id,
        int(now_ms),
        600_000,
        60_000,
        3,
        720,
    )
    return int(result or 0) in {1, 2}


async def settle_soft_slot(redis, *, platform: str, bot_id: str, group_id: str,
                           sender_id: str, run_id: str, outcome: str,
                           now_ms: int, ttl_seconds: int = 720) -> bool:
    """提交 SOFT 预算状态；释放失败预留时同时清理发送者和群共享槽位。"""
    if not all((sender_id, run_id)):
        return False
    group_key, sender_key, _ = _soft_keys(platform, bot_id, group_id, sender_id)
    result = await redis.eval(
        _SETTLE_SOFT_SCRIPT,
        3,
        group_key,
        sender_key,
        _state_key(platform, bot_id, group_id),
        run_id,
        outcome,
        int(now_ms),
        max(120, int(ttl_seconds)),
    )
    return bool(int(result or 0))


async def renew_soft_slot(redis, *, platform: str, bot_id: str, group_id: str,
                          sender_id: str, run_id: str, ttl_seconds: int = 720,
                          now_ms: int | None = None) -> bool:
    now_ms = int(now_ms or time.time() * 1000)
    group_key, sender_key, _ = _soft_keys(platform, bot_id, group_id, sender_id)
    result = await redis.eval(
        _RENEW_SOFT_SCRIPT,
        3,
        group_key,
        sender_key,
        _state_key(platform, bot_id, group_id),
        run_id,
        max(120, int(ttl_seconds)),
        now_ms,
        max(120, int(ttl_seconds)) * 1000,
    )
    return bool(int(result or 0))


__all__ = [
    "get_soft_anchor", "register_soft_anchor", "release_proactive_slot",
    "recent_proactive_acceptances", "renew_proactive_slot", "reserve_proactive_slot", "reserve_soft_slot",
    "renew_soft_slot", "settle_proactive_slot", "settle_soft_slot",
]
