"""已邀请群聊的成员级短期续接窗口。"""
from __future__ import annotations

from hashlib import sha256


CONVERSATION_TTL_SECONDS = 180
_STATE_RETENTION_SECONDS = 3_600

_RECORD_REPLY_SCRIPT = """
local key = KEYS[1]
local previous_run = redis.call('HGET', key, 'run_key')
if previous_run and previous_run == ARGV[1] then return 0 end
redis.call('HSET', key,
  'run_key', ARGV[1],
  'source_event_id', ARGV[2],
  'accepted_at_ms', ARGV[3],
  'expires_at_ms', ARGV[4])
redis.call('EXPIRE', key, tonumber(ARGV[5]))
return 1
"""


def _conversation_key(platform: str, bot_id: str, group_id: str, sender_id: str) -> str:
    scope = "\0".join((platform, bot_id, group_id, sender_id))
    digest = sha256(scope.encode("utf-8")).hexdigest()
    return f"im:attention:conversation:v1:{digest}"


def _field_text(fields: dict, key: str) -> str:
    value = fields.get(key)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value or "")


async def record_accepted_reply(
    redis,
    *,
    platform: str,
    bot_id: str,
    group_id: str,
    sender_id: str,
    run_key: str,
    source_event_id: str,
    accepted_at_ms: int,
    ttl_seconds: int = CONVERSATION_TTL_SECONDS,
) -> bool:
    """以一次已接受的最终回复创建或续期窗口；同一 Run 幂等。"""
    if not all((platform, bot_id, group_id, sender_id, run_key, source_event_id)):
        return False
    ttl = max(1, int(ttl_seconds))
    accepted = int(accepted_at_ms)
    return bool(int(await redis.eval(
        _RECORD_REPLY_SCRIPT,
        1,
        _conversation_key(platform, bot_id, group_id, sender_id),
        run_key,
        source_event_id,
        accepted,
        accepted + ttl * 1000,
        max(_STATE_RETENTION_SECONDS, ttl),
    ) or 0))


async def has_active_conversation(
    redis,
    *,
    platform: str,
    bot_id: str,
    group_id: str,
    sender_id: str,
    event_received_ms: int,
) -> bool:
    """只接受在最近一次已确认回复之后、逻辑 TTL 到期之前到达的消息。"""
    if not all((platform, bot_id, group_id, sender_id)):
        return False
    if not hasattr(redis, "hgetall"):
        return False
    key = _conversation_key(platform, bot_id, group_id, sender_id)
    fields = await redis.hgetall(key)
    if not fields:
        return False
    try:
        accepted_at_ms = int(_field_text(fields, "accepted_at_ms"))
        expires_at_ms = int(_field_text(fields, "expires_at_ms"))
        received_at_ms = int(event_received_ms)
    except (TypeError, ValueError):
        await redis.delete(key)
        return False
    if received_at_ms <= accepted_at_ms:
        return False
    if received_at_ms > expires_at_ms:
        await redis.delete(key)
        return False
    return True


async def close_conversation(
    redis, *, platform: str, bot_id: str, group_id: str, sender_id: str,
) -> None:
    if all((platform, bot_id, group_id, sender_id)):
        await redis.delete(_conversation_key(platform, bot_id, group_id, sender_id))


def accepted_final_reply_receipt(receipts: object) -> dict | None:
    """从本 Run 的投递收据中取最后一条已接受的 Agent 最终回复。"""
    if not isinstance(receipts, list):
        return None
    return next((
        item for item in reversed(receipts)
        if isinstance(item, dict)
        and item.get("role") == "answer"
        and item.get("status") == "ACCEPTED"
    ), None)


async def record_conversation_after_final_reply(payload: dict, *, run_key: str) -> bool:
    """只在本 Run 的 Agent 最终回复有平台接受回执时建立窗口。"""
    subject_sender_id = str(payload.get("_attention_conversation_subject_sender_id") or "")
    source_event_ids = payload.get("_attention_source_event_ids") or []
    receipt = accepted_final_reply_receipt(payload.get("_attention_outbound_receipts"))
    if (
        payload.get("chat_type") != "group"
        or not subject_sender_id
        or not source_event_ids
        or receipt is None
    ):
        return False
    try:
        accepted_at_ms = int(receipt.get("accepted_at_ms") or 0)
    except (TypeError, ValueError):
        accepted_at_ms = 0
    if accepted_at_ms <= 0:
        return False

    from app.core import redis as R

    return await record_accepted_reply(
        R.get_redis(),
        platform=str(payload.get("platform") or ""),
        bot_id=str(payload.get("channel_id") or payload.get("bot_id") or ""),
        group_id=str(payload.get("chat_id") or ""),
        sender_id=subject_sender_id,
        run_key=run_key,
        source_event_id=str(source_event_ids[0]),
        accepted_at_ms=accepted_at_ms,
    )


__all__ = [
    "CONVERSATION_TTL_SECONDS",
    "accepted_final_reply_receipt",
    "close_conversation",
    "has_active_conversation",
    "record_accepted_reply",
    "record_conversation_after_final_reply",
]
