"""群聊注意力门控的出站回执索引；只存结构化投递事实，不存消息正文。"""
from __future__ import annotations

from hashlib import sha256
import json


_BEGIN_SCRIPT = """
local key = KEYS[1]
if redis.call('HGET', key, 'status') then return redis.call('HGET', key, 'status') end
redis.call('HSET', key,
  'status', 'SUBMITTED',
  'platform', ARGV[1],
  'bot_id', ARGV[2],
  'group_id', ARGV[3],
  'run_key', ARGV[4],
  'source_event_ids', ARGV[5],
  'answer_source_event_ids', ARGV[6],
  'recipient_sender_id', ARGV[7],
  'budget_kind', ARGV[8],
  'submitted_at_ms', ARGV[9])
redis.call('EXPIRE', key, tonumber(ARGV[10]))
return 'NEW'
"""

_SETTLE_SCRIPT = """
local key = KEYS[1]
local current = redis.call('HGET', key, 'status')
if not current then return 0 end
if current == 'ACCEPTED' or current == 'UNRESOLVED' then return 1 end
if current == 'FAILED_CONFIRMED' then return 0 end
local outcome = ARGV[1]
local accepted_at_ms = ARGV[2]
local retention_seconds = tonumber(ARGV[3])
local message_count = tonumber(ARGV[4])
local source_count = tonumber(ARGV[5 + message_count])
if outcome == 'ACCEPTED' then
  redis.call('HSET', key, 'status', 'ACCEPTED', 'accepted_at_ms', accepted_at_ms)
  for index = 1, message_count do
    local platform_message_id = ARGV[4 + index]
    local message_key = KEYS[1 + index]
    redis.call('HSET', message_key,
      'status', 'ACCEPTED',
      'run_key', redis.call('HGET', key, 'run_key'),
      'recipient_sender_id', redis.call('HGET', key, 'recipient_sender_id') or '',
      'accepted_at_ms', accepted_at_ms,
      'platform_message_id', platform_message_id,
      'proactive', redis.call('HGET', key, 'budget_kind') == 'proactive' and '1' or '0')
    redis.call('EXPIRE', message_key, retention_seconds)
  end
  if message_count > 0 then redis.call('HSET', key, 'platform_message_id', ARGV[5]) end
  for index = 1, source_count do
    local source_event_id = ARGV[5 + message_count + index]
    local source_key = KEYS[1 + message_count + index]
    redis.call('HSET', source_key,
      'status', 'ACCEPTED',
      'run_key', redis.call('HGET', key, 'run_key'),
      'recipient_sender_id', redis.call('HGET', key, 'recipient_sender_id') or '',
      'accepted_at_ms', accepted_at_ms,
      'source_event_id', source_event_id,
      'proactive', redis.call('HGET', key, 'budget_kind') == 'proactive' and '1' or '0')
    redis.call('EXPIRE', source_key, retention_seconds)
  end
elseif outcome == 'UNRESOLVED' then
  redis.call('HSET', key, 'status', 'UNRESOLVED')
elseif outcome == 'FAILED_CONFIRMED' then
  redis.call('HSET', key, 'status', 'FAILED_CONFIRMED')
else
  return 0
end
redis.call('EXPIRE', key, retention_seconds)
return 1
"""


def _scope_digest(platform: str, bot_id: str, group_id: str) -> str:
    return sha256(f"{platform}\0{bot_id}\0{group_id}".encode()).hexdigest()


def delivery_id_for(run_key: str, ordinal: int) -> str:
    return sha256(f"{run_key}\0{int(ordinal)}".encode()).hexdigest()


def _delivery_key(scope_digest: str, delivery_id: str) -> str:
    return f"im:attention:ledger:{{{scope_digest}}}:delivery:{delivery_id}"


def _message_key(scope_digest: str, platform_message_id: str) -> str:
    message_digest = sha256(platform_message_id.encode()).hexdigest()
    return f"im:attention:ledger:{{{scope_digest}}}:message:{message_digest}"


async def begin_delivery(redis, *, delivery_id: str, platform: str, bot_id: str,
                         group_id: str, run_key: str, source_event_ids: list[str],
                         answer_source_event_ids: list[str] | None = None,
                         recipient_sender_id: str | None, budget_kind: str | None,
                         submitted_at_ms: int, retention_seconds: int = 86_400) -> str:
    digest = _scope_digest(platform, bot_id, group_id)
    return str(await redis.eval(
        _BEGIN_SCRIPT,
        1,
        _delivery_key(digest, delivery_id),
        platform,
        bot_id,
        group_id,
        run_key,
        json.dumps(source_event_ids, ensure_ascii=False, separators=(",", ":")),
        json.dumps(answer_source_event_ids or [], ensure_ascii=False, separators=(",", ":")),
        recipient_sender_id or "",
        budget_kind or "",
        int(submitted_at_ms),
        max(180, int(retention_seconds)),
    ))


async def settle_delivery(redis, *, delivery_id: str, platform: str, bot_id: str,
                          group_id: str, outcome: str,
                          platform_message_id: str | None = None,
                          platform_message_ids: list[str] | None = None,
                          answer_source_event_ids: list[str] | None = None,
                          accepted_at_ms: int = 0,
                          retention_seconds: int = 86_400) -> bool:
    digest = _scope_digest(platform, bot_id, group_id)
    ids = list(dict.fromkeys(
        str(value) for value in (platform_message_ids or [])
        if value
    ))
    if platform_message_id and platform_message_id not in ids:
        ids.append(platform_message_id)
    source_ids = list(dict.fromkeys(str(value) for value in (answer_source_event_ids or []) if value))
    keys = [_delivery_key(digest, delivery_id)]
    keys.extend(_message_key(digest, value) for value in ids)
    keys.extend(_message_key(digest, f"source:{value}") for value in source_ids)
    result = await redis.eval(
        _SETTLE_SCRIPT,
        len(keys),
        *keys,
        outcome,
        int(accepted_at_ms),
        max(180, int(retention_seconds)),
        len(ids),
        *ids,
        len(source_ids),
        *source_ids,
    )
    return bool(int(result or 0))


async def lookup_bot_reply(redis, *, platform: str, bot_id: str, group_id: str,
                           platform_message_id: str) -> dict | None:
    digest = _scope_digest(platform, bot_id, group_id)
    values = await redis.hgetall(_message_key(digest, platform_message_id))
    if not values:
        return None
    return values


async def lookup_answer_for_source_event(redis, *, platform: str, bot_id: str,
                                         group_id: str, source_event_id: str) -> dict | None:
    digest = _scope_digest(platform, bot_id, group_id)
    values = await redis.hgetall(_message_key(digest, f"source:{source_event_id}"))
    return values or None


__all__ = [
    "begin_delivery", "delivery_id_for", "lookup_answer_for_source_event",
    "lookup_bot_reply", "settle_delivery",
]
