"""群聊注意力门控的出站回执索引；只存结构化投递事实，不存消息正文。"""
from __future__ import annotations

from hashlib import sha256
import json


_BEGIN_SCRIPT = """
local key = KEYS[1]
if redis.call('HGET', key, 'status') then return redis.call('HGET', key, 'status') end
redis.call('HSET', key,
  'status', 'SUBMITTED',
  'delivery_id', ARGV[11],
  'platform', ARGV[1],
  'bot_id', ARGV[2],
  'group_id', ARGV[3],
  'run_key', ARGV[4],
  'source_event_ids', ARGV[5],
  'answer_source_event_ids', ARGV[6],
  'recipient_sender_id', ARGV[7],
  'proactive', ARGV[8],
  'submitted_at_ms', ARGV[9],
  'source_attention_kind', ARGV[12])
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
      'delivery_id', redis.call('HGET', key, 'delivery_id') or '',
      'recipient_sender_id', redis.call('HGET', key, 'recipient_sender_id') or '',
      'accepted_at_ms', accepted_at_ms,
      'platform_message_id', platform_message_id,
      'proactive', redis.call('HGET', key, 'proactive') or '0',
      'source_attention_kind', redis.call('HGET', key, 'source_attention_kind') or '',
      'final_payload_text', redis.call('HGET', key, 'final_payload_text') or '',
      'final_payload_hash', redis.call('HGET', key, 'final_payload_hash') or '')
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
      'proactive', redis.call('HGET', key, 'proactive') or '0')
    redis.call('EXPIRE', source_key, retention_seconds)
  end
  if tonumber(ARGV[6 + message_count + source_count]) == 1 then
    local member_index_key = KEYS[2 + message_count + source_count]
    redis.call('ZADD', member_index_key, accepted_at_ms, redis.call('HGET', key, 'delivery_id') or '')
    redis.call('EXPIRE', member_index_key, retention_seconds)
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


def _latest_key(scope_digest: str) -> str:
    return f"im:attention:ledger:{{{scope_digest}}}:latest"


def _member_latest_key(scope_digest: str, sender_id: str) -> str:
    sender_digest = sha256(sender_id.encode()).hexdigest()
    return f"im:attention:ledger:{{{scope_digest}}}:member-latest:{sender_digest}"


async def begin_delivery(redis, *, delivery_id: str, platform: str, bot_id: str,
                         group_id: str, run_key: str, source_event_ids: list[str],
                         answer_source_event_ids: list[str] | None = None,
                         recipient_sender_id: str | None, proactive: bool,
                         submitted_at_ms: int, final_payload_text: str | None = None,
                         source_attention_kind: str | None = None,
                         retention_seconds: int = 86_400) -> str:
    digest = _scope_digest(platform, bot_id, group_id)
    state = str(await redis.eval(
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
        "1" if proactive else "0",
        int(submitted_at_ms),
        max(180, int(retention_seconds)),
        delivery_id,
        str(source_attention_kind or ""),
    ))
    if state == "NEW":
        await _attach_final_payload(
            redis, platform=platform, bot_id=bot_id, group_id=group_id,
            delivery_id=delivery_id, final_payload_text=final_payload_text,
            retention_seconds=retention_seconds,
        )
    return state


async def _attach_final_payload(redis, *, platform: str, bot_id: str, group_id: str,
                                delivery_id: str, final_payload_text: str | None,
                                retention_seconds: int = 86_400) -> None:
    """保存在受限短期账本中，正文不进入日志；摘要用于读取时校验。"""
    if not final_payload_text:
        return
    digest = _scope_digest(platform, bot_id, group_id)
    text = str(final_payload_text)
    await redis.hset(_delivery_key(digest, delivery_id), mapping={
        "final_payload_text": text,
        "final_payload_hash": sha256(text.encode("utf-8")).hexdigest(),
    })
    await redis.expire(_delivery_key(digest, delivery_id), max(180, int(retention_seconds)))


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
    source_kind = await redis.hget(_delivery_key(digest, delivery_id), "source_attention_kind")
    recipient_sender_id = await redis.hget(_delivery_key(digest, delivery_id), "recipient_sender_id")
    if isinstance(source_kind, bytes):
        source_kind = source_kind.decode("utf-8", errors="replace")
    if isinstance(recipient_sender_id, bytes):
        recipient_sender_id = recipient_sender_id.decode("utf-8", errors="replace")
    member_activation_enabled = bool(
        recipient_sender_id
        and source_kind in {
            "DIRECT", "member_CONTINUE", "CAPABILITY_ACTION",
            "member_ACTIVE", "proactive", "autonomous",
        }
    )
    keys = [_delivery_key(digest, delivery_id)]
    keys.extend(_message_key(digest, value) for value in ids)
    keys.extend(_message_key(digest, f"source:{value}") for value in source_ids)
    keys.append(
        _member_latest_key(digest, str(recipient_sender_id))
        if member_activation_enabled else _latest_key(digest)
    )
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
        1 if member_activation_enabled else 0,
    )
    settled = bool(int(result or 0))
    if settled and outcome == "ACCEPTED":
        await redis.zadd(_latest_key(digest), {str(delivery_id): int(accepted_at_ms)})
        await redis.expire(_latest_key(digest), max(180, int(retention_seconds)))
    return settled


async def accepted_finals_before(redis, *, platform: str, bot_id: str, group_id: str,
                                 watermark_ms: int, limit: int = 11) -> list[dict]:
    """返回水位前近期 accepted 出站消息，保留真实顺序与正文摘要校验。"""
    digest = _scope_digest(platform, bot_id, group_id)
    ids = await redis.zrevrangebyscore(
        _latest_key(digest), int(watermark_ms), "-inf", start=0, num=max(1, min(int(limit), 32)),
    )
    results = []
    for raw_id in ids:
        delivery_id = raw_id.decode() if isinstance(raw_id, bytes) else str(raw_id)
        fields = await redis.hgetall(_delivery_key(digest, delivery_id))
        if not fields:
            continue
        text = fields.get("final_payload_text")
        expected_hash = fields.get("final_payload_hash")
        if isinstance(text, bytes): text = text.decode("utf-8", errors="replace")
        if isinstance(expected_hash, bytes): expected_hash = expected_hash.decode("ascii", errors="replace")
        fields["delivery_id"] = delivery_id
        source_kind = fields.get("source_attention_kind")
        if isinstance(source_kind, bytes):
            source_kind = source_kind.decode("utf-8", errors="replace")
        if source_kind not in {
            "DIRECT", "member_CONTINUE", "CAPABILITY_ACTION",
            "member_ACTIVE", "proactive", "autonomous",
        }:
            continue
        if not text or not expected_hash or sha256(str(text).encode("utf-8")).hexdigest() != expected_hash:
            fields.pop("final_payload_text", None)
        results.append(fields)
    return results


async def member_activation_before(redis, *, platform: str, bot_id: str, group_id: str,
                                  sender_id: str, watermark_ms: int) -> dict | None:
    """按成员索引读取水位前最近一条可激活的已接受最终答复。"""
    digest = _scope_digest(platform, bot_id, group_id)
    delivery_ids = await redis.zrevrangebyscore(
        _member_latest_key(digest, sender_id), int(watermark_ms), "-inf", start=0, num=1,
    )
    if not delivery_ids:
        return None
    raw_id = delivery_ids[0]
    delivery_id = raw_id.decode() if isinstance(raw_id, bytes) else str(raw_id)
    fields = await redis.hgetall(_delivery_key(digest, delivery_id))
    if not fields:
        return None
    fields["delivery_id"] = delivery_id
    return fields


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
    "accepted_finals_before",
    "member_activation_before",
    "_attach_final_payload",
]
