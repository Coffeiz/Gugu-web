"""群聊开放提问的延迟介入状态。"""
from __future__ import annotations

import hashlib
import json
import time
from typing import Any

from app.core import redis as R

PENDING_ASK_MIN_WAIT_MS = 60_000
PENDING_ASK_QUIET_MS = 30_000
PENDING_ASK_MAX_WAIT_MS = 180_000
_INDEX_KEY = "im:{pending_ask}:due:v1"
_STATE_PREFIX = "im:{pending_ask}:state:v1:"
_ACTIVITY_PREFIX = "im:{pending_ask}:activity:v1:"
_CANCELLED_PREFIX = "im:{pending_ask}:cancelled:v1:"


def _scope(payload: dict) -> tuple[str, str] | None:
    values = (
        payload.get("platform"),
        payload.get("channel_id") or payload.get("bot_id"),
        payload.get("chat_id"),
        payload.get("owner_user_id") or payload.get("user_id"),
    )
    if any(value is None or not str(value).strip() for value in values):
        return None
    raw = "\x1f".join(str(value).strip() for value in values)
    scope_id = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return scope_id, f"{_STATE_PREFIX}{scope_id}"


def _event_ms(event_id: Any) -> int:
    try:
        from agent.im.auto_reply.attention import _stream_event_ms

        return _stream_event_ms(str(event_id))
    except Exception:
        return int(time.time() * 1000)


_REGISTER_SCRIPT = """
  local key, index, activity_key = KEYS[1], KEYS[2], KEYS[3]
local scope_id, event_ms, payload_json = ARGV[1], tonumber(ARGV[2]), ARGV[3]
local min_wait, quiet, max_wait = tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])
local raw = redis.call('GET', key)
local state
if raw then
  state = cjson.decode(raw)
  local previous_latest = tonumber(state.latest_ask_ms)
  state.latest_ask_ms = math.max(previous_latest, event_ms)
  if event_ms >= previous_latest then state.payload = cjson.decode(payload_json) end
else
  state = {
    started_ms = event_ms,
    latest_ask_ms = event_ms,
    last_activity_ms = event_ms,
    payload = cjson.decode(payload_json)
  }
end
local latest_activity = tonumber(redis.call('GET', activity_key) or event_ms)
state.last_activity_ms = math.max(tonumber(state.last_activity_ms), latest_activity)
state.resume_id = scope_id .. ':' .. tostring(state.started_ms) .. ':' .. tostring(state.latest_ask_ms)
local due = math.max(
  tonumber(state.started_ms) + min_wait,
  tonumber(state.latest_ask_ms) + min_wait,
  tonumber(state.last_activity_ms) + quiet
)
due = math.min(due, tonumber(state.started_ms) + max_wait)
redis.call('SET', key, cjson.encode(state), 'EX', 600)
redis.call('ZADD', index, due, scope_id)
return due
"""

_ACTIVITY_SCRIPT = """
  local key, index, activity_key = KEYS[1], KEYS[2], KEYS[3]
local scope_id, event_ms = ARGV[1], tonumber(ARGV[2])
local min_wait, quiet, max_wait = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local previous_activity = tonumber(redis.call('GET', activity_key) or '0')
local last_activity = math.max(previous_activity, event_ms)
redis.call('SET', activity_key, last_activity, 'EX', 600)
local raw = redis.call('GET', key)
if not raw then return 0 end
local state = cjson.decode(raw)
state.last_activity_ms = math.max(tonumber(state.last_activity_ms), last_activity)
local due = math.max(
  tonumber(state.started_ms) + min_wait,
  tonumber(state.latest_ask_ms) + min_wait,
  tonumber(state.last_activity_ms) + quiet
)
due = math.min(due, tonumber(state.started_ms) + max_wait)
redis.call('SET', key, cjson.encode(state), 'EX', 600)
redis.call('ZADD', index, due, scope_id)
return 1
"""

_CLAIM_DUE_SCRIPT = """
local key, index = KEYS[1], KEYS[2]
local scope_id, now = ARGV[1], tonumber(ARGV[2])
local min_wait, quiet, max_wait = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local raw = redis.call('GET', key)
if not raw then redis.call('ZREM', index, scope_id); return {'missing'} end
local state = cjson.decode(raw)
local max_at = tonumber(state.started_ms) + max_wait
local ask_ready = now >= tonumber(state.latest_ask_ms) + min_wait
local quiet_now = now - tonumber(state.last_activity_ms) >= quiet
if now >= max_at then
  if ask_ready and quiet_now then
    redis.call('ZADD', index, now + 5000, scope_id)
    return {'ready', raw}
  end
  redis.call('DEL', key)
  redis.call('ZREM', index, scope_id)
  return {'expired'}
end
local due = math.max(
  tonumber(state.started_ms) + min_wait,
  tonumber(state.latest_ask_ms) + min_wait,
  tonumber(state.last_activity_ms) + quiet
)
due = math.min(due, max_at)
if due > now then
  redis.call('ZADD', index, due, scope_id)
  return {'wait'}
end
if ask_ready and quiet_now then
  redis.call('ZADD', index, now + 5000, scope_id)
  return {'ready', raw}
end
return {'wait'}
"""

_COMPLETE_SCRIPT = """
local key, index = KEYS[1], KEYS[2]
local scope_id, resume_id = ARGV[1], ARGV[2]
local raw = redis.call('GET', key)
if not raw then redis.call('ZREM', index, scope_id); return 1 end
local state = cjson.decode(raw)
if state.resume_id ~= resume_id then return 0 end
redis.call('DEL', key)
redis.call('ZREM', index, scope_id)
return 1
"""

_CANCEL_SCRIPT = """
local state_key, index, cancelled_key = KEYS[1], KEYS[2], KEYS[3]
local scope_id, cancel_ms = ARGV[1], tonumber(ARGV[2])
local previous = tonumber(redis.call('GET', cancelled_key) or '0')
if cancel_ms > previous then
  redis.call('SET', cancelled_key, cancel_ms, 'EX', 600)
end
redis.call('DEL', state_key)
redis.call('ZREM', index, scope_id)
return 1
"""


async def register_pending_ask(
    payload: dict, *, event_ms: int, session_id: int | None = None,
) -> str | None:
    """登记并合并同群开放 ASK；按首问时间设置不可延长的 180 秒上限。"""
    scoped = _scope(payload)
    if scoped is None:
        return None
    scope_id, key = scoped
    activity_key = f"{_ACTIVITY_PREFIX}{scope_id}"
    safe_payload = dict(payload)
    if session_id is not None:
        safe_payload["session_id"] = int(session_id)
    safe_payload.pop("_pending_ask_resume", None)
    safe_payload.pop("_pending_ask_resume_id", None)
    await R.get_redis().eval(
        _REGISTER_SCRIPT, 3, key, _INDEX_KEY, activity_key,
        scope_id, int(event_ms), json.dumps(safe_payload, ensure_ascii=False),
        PENDING_ASK_MIN_WAIT_MS, PENDING_ASK_QUIET_MS, PENDING_ASK_MAX_WAIT_MS,
    )
    return scope_id


async def observe_group_activity(payload: dict) -> None:
    """以所有非咕咕入站消息刷新静默时钟，不区分人类或其他 Bot。"""
    if payload.get("_pending_ask_resume") is True:
        return
    scoped = _scope(payload)
    if scoped is None:
        return
    scope_id, key = scoped
    activity_key = f"{_ACTIVITY_PREFIX}{scope_id}"
    items = payload.get("_batch_messages")
    if not isinstance(items, list) or not items:
        items = [payload]
    latest_activity_ms = None
    for item in items:
        if not isinstance(item, dict):
            continue
        sender_id = str(item.get("platform_user_id") or "").strip()
        gugu_id = str(
            item.get("platform_bot_user_id") or payload.get("platform_bot_user_id") or ""
        ).strip()
        if sender_id and gugu_id and sender_id == gugu_id:
            continue
        event_ms = _event_ms(item.get("event_id") or item.get("_redis_stream_id"))
        latest_activity_ms = max(latest_activity_ms or event_ms, event_ms)
    if latest_activity_ms is not None:
        await R.get_redis().eval(
            _ACTIVITY_SCRIPT, 3, key, _INDEX_KEY, activity_key,
            scope_id, latest_activity_ms,
            PENDING_ASK_MIN_WAIT_MS, PENDING_ASK_QUIET_MS, PENDING_ASK_MAX_WAIT_MS,
        )


async def cancel_pending_ask(payload: dict) -> None:
    scoped = _scope(payload)
    if scoped is None:
        return
    scope_id, key = scoped
    event_ms = _payload_event_ms(payload) or int(time.time() * 1000)
    try:
        await R.get_redis().eval(
            _CANCEL_SCRIPT, 3, key, _INDEX_KEY,
            f"{_CANCELLED_PREFIX}{scope_id}", scope_id, event_ms,
        )
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.attention.pending_ask_cancel", exc)


def _payload_event_ms(payload: dict) -> int:
    items = payload.get("_batch_messages")
    if not isinstance(items, list) or not items:
        items = [payload]
    timestamps = [
        _event_ms(item.get("event_id") or item.get("_redis_stream_id"))
        for item in items if isinstance(item, dict)
    ]
    return max(timestamps, default=0)


def is_current_bot_mention(payload: dict) -> bool:
    """识别结构化当前 Bot @，供早于模式分流的 pending 取消使用。"""
    items = payload.get("_batch_messages")
    if not isinstance(items, list) or not items:
        items = [payload]
    for item in items:
        if not isinstance(item, dict) or item.get("has_unresolved_mention") is True:
            continue
        if item.get("native_bot_mentioned") is True:
            return True
        if item.get("mentions_other_bot") is not True and (
            item.get("bot_mentioned") is True
            or item.get("group_mentioned") is True
        ):
            return True
    return False


async def pending_ask_was_cancelled(payload: dict) -> bool:
    """丢弃已被后续明确召唤取代、但已排入入站流的过期唤醒。"""
    if payload.get("_pending_ask_resume") is not True:
        return False
    scope_id = str(payload.get("_pending_ask_scope") or "").strip()
    if not scope_id:
        return False
    try:
        raw = await R.get_redis().get(f"{_CANCELLED_PREFIX}{scope_id}")
        if isinstance(raw, bytes):
            raw = raw.decode("ascii", errors="ignore")
        cancelled_ms = int(raw or 0)
        ask_ms = int(payload.get("_pending_ask_latest_ms") or 0)
    except (TypeError, ValueError):
        return False
    return bool(ask_ms and cancelled_ms >= ask_ms)


async def claim_due_pending_asks(*, now_ms: int | None = None, limit: int = 100) -> list[tuple[str, dict]]:
    """返回到期且安静的消息；完成入队后再删除，崩溃时依靠入站幂等键重试。"""
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    redis = R.get_redis()
    scopes = await redis.zrangebyscore(_INDEX_KEY, min="-inf", max=now, start=0, num=limit)
    ready: list[tuple[str, dict]] = []
    for scope_id in scopes:
        key = f"{_STATE_PREFIX}{scope_id}"
        result = await redis.eval(
            _CLAIM_DUE_SCRIPT, 2, key, _INDEX_KEY,
            scope_id, now,
            PENDING_ASK_MIN_WAIT_MS, PENDING_ASK_QUIET_MS, PENDING_ASK_MAX_WAIT_MS,
        )
        if not result or result[0] != "ready" or len(result) < 2:
            continue
        try:
            state = json.loads(result[1])
            payload = state.get("payload")
            resume_id = str(state.get("resume_id") or "")
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict) and resume_id:
            payload = dict(payload)
            payload["_pending_ask_resume"] = True
            payload["_pending_ask_resume_id"] = resume_id
            payload["_pending_ask_scope"] = scope_id
            payload["_pending_ask_latest_ms"] = int(state.get("latest_ask_ms") or 0)
            ready.append((scope_id, payload))
    return ready


async def complete_pending_ask(scope_id: str, resume_id: str) -> bool:
    key = f"{_STATE_PREFIX}{scope_id}"
    result = await R.get_redis().eval(
        _COMPLETE_SCRIPT, 2, key, _INDEX_KEY, scope_id, resume_id,
    )
    return bool(result)


__all__ = [
    "PENDING_ASK_MIN_WAIT_MS", "PENDING_ASK_QUIET_MS", "PENDING_ASK_MAX_WAIT_MS",
    "register_pending_ask", "observe_group_activity", "cancel_pending_ask",
    "claim_due_pending_asks", "complete_pending_ask",
    "is_current_bot_mention", "pending_ask_was_cancelled",
]
