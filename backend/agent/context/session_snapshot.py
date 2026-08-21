"""Session snapshot 的规范化 hash、TTL 和 checkpoint 元数据。"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable

from app.core.tz import now_utc, resolve_tz, LOCAL_TZ

DEFAULT_IDLE_TTL = timedelta(minutes=30)


def _tz_storage_value(user_tz) -> str:
    """JSON 只保存 IANA 名称；服务器固定偏移统一记为 LOCAL。"""
    return getattr(user_tz, "key", None) or "LOCAL"


def current_time_text(user_tz=None) -> str:
    """生成每轮尾部的时间消息；它不进入 snapshot 前缀。"""
    current = datetime.now(user_tz or LOCAL_TZ)
    weekday = "一二三四五六日"[current.weekday()]
    text = f"{current:%Y-%m-%d}（星期{weekday}）{current:%H:%M}"
    if current.hour < 4:
        text += "，深夜未眠——以日出为一天的分界：用户口中的「今天」指尚未结束的这个主观白天（日历昨天），「明天」指日出后的那天（日历今天），涉及日期时请按此理解"
    return text


def reminder_message(content: str) -> dict:
    """生成不带观测元数据的固定 reminder 消息。"""
    return {"role": "user", "content": f"[system-reminder]\n{content}\n[/system-reminder]"}


def time_message(user_tz=None) -> dict:
    """生成每轮唯一变化的尾部时间消息。"""
    return reminder_message(f"当前时间：{current_time_text(user_tz)}")


def canonical(value: Any) -> str:
    """生成不受字典顺序影响的稳定 JSON。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def session_info_hash(session_info: dict) -> str:
    return digest({"session_info": session_info})


def snapshot_hash(system_hash: str, session_hash: str, covered_message_hash: str) -> str:
    return digest({
        "system_hash": system_hash,
        "session_info_hash": session_hash,
        "covered_message_hash": covered_message_hash,
    })


def is_expired(session, now: datetime | None = None) -> bool:
    expires_at = getattr(session, "snapshot_expires_at", None)
    return expires_at is not None and expires_at <= (now or now_utc())


def next_expiry(now: datetime | None = None, ttl: timedelta = DEFAULT_IDLE_TTL) -> datetime:
    return (now or now_utc()) + ttl


def message_hash(messages: list[dict]) -> str:
    """只 hash 真正发给模型的消息，不接收 trace/cache 元数据。"""
    normalized = [
        {"role": message.get("role"), "content": message.get("content")}
        for message in messages
    ]
    return digest(normalized)


def snapshot_is_usable(session, now: datetime | None = None,
                       context_revision: int | None = None) -> bool:
    """判断当前 session 是否已有未过期的可复用 snapshot。"""
    context = getattr(session, "session_context", None)
    return bool(
        isinstance(context, dict)
        and context.get("system_prompt") is not None
        and context.get("session_info") is not None
        and not is_expired(session, now)
        and (context_revision is None
             or int(context.get("context_revision", 0) or 0) == context_revision)
    )


def invalidate_snapshot(session) -> None:
    """显式标记下次 run 重建上下文；不触碰历史消息。"""
    session.snapshot_expires_at = now_utc() - timedelta(seconds=1)


def snapshot_context(session) -> dict:
    """读取已经冻结的 prompt 输入；调用方不得修改返回值后回写。"""
    context = getattr(session, "session_context", None) or {}
    return {
        "system_prompt": str(context.get("system_prompt") or ""),
        "dynamic_context": str(context.get("dynamic_context") or ""),
        "session_info": context.get("session_info") or {},
        "user_tz": resolve_tz(context.get("user_tz")) if context.get("user_tz") != "LOCAL" else LOCAL_TZ,
        "im_channels": context.get("im_channels") or {},
        "im_memory": context.get("im_memory") or {},
    }


def _record_snapshot_event(session, phase: str) -> None:
    """把 snapshot 生命周期以脱敏事件写入旁路 trace。"""
    try:
        from agent.runtime.trace import record_snapshot_event

        record_snapshot_event(
            phase,
            context_epoch=getattr(session, "context_epoch", None),
            snapshot_hash=getattr(session, "snapshot_hash", None),
            session_info_hash=getattr(session, "session_info_hash", None),
            expires_at=getattr(session, "snapshot_expires_at", None),
        )
    except Exception:
        # 观测平面不可用时不影响上下文组装。
        return


def initialize_snapshot(
    session,
    *,
    system_prompt: str,
    dynamic_context: str,
    session_info: dict,
    user_tz: str | None,
    im_channels: dict | None = None,
    im_memory: dict | None = None,
    context_revision: int = 0,
    covered_messages: list[dict] | None = None,
    now: datetime | None = None,
    ttl: timedelta = DEFAULT_IDLE_TTL,
) -> str:
    """建立或重建 snapshot，返回 snapshot hash。"""
    current = now or now_utc()
    normalized_info = {
        "system_prompt": system_prompt,
        "session_info": session_info,
    }
    info_hash = digest(normalized_info)
    # 新 session 的默认 epoch=1；只有已有 snapshot 的重建才递增，避免首次建立变成 2。
    if getattr(session, "session_context", None) is None:
        session.context_epoch = 1
    else:
        session.context_epoch = (getattr(session, "context_epoch", None) or 1) + 1
    session.session_context = {
        "system_prompt": system_prompt,
        "dynamic_context": dynamic_context,
        "session_info": session_info,
        "user_tz": _tz_storage_value(user_tz),
        "im_channels": im_channels or {},
        "im_memory": im_memory or {},
        "context_revision": context_revision,
    }
    session.session_info_hash = info_hash
    session.snapshot_hash = snapshot_hash(
        digest(system_prompt),
        info_hash,
        message_hash(covered_messages or []),
    )
    session.snapshot_expires_at = current + ttl
    return session.snapshot_hash


def checkpoint_snapshot(
    session,
    messages: list[dict],
    *,
    now: datetime | None = None,
    ttl: timedelta = DEFAULT_IDLE_TTL,
) -> str:
    """将本轮新增消息纳入 snapshot hash，并刷新 idle TTL。"""
    context = snapshot_context(session)
    current = now or now_utc()
    covered_hash = digest({
        "previous_snapshot": session.snapshot_hash or "",
        "new_messages": message_hash(messages),
    })
    session.snapshot_hash = snapshot_hash(
        digest(context["system_prompt"]),
        getattr(session, "session_info_hash", None) or session_info_hash(context["session_info"]),
        covered_hash,
    )
    session.snapshot_expires_at = current + ttl
    return session.snapshot_hash


async def ensure_snapshot(
    db,
    session,
    *,
    load_context: Callable[[], Awaitable[dict]],
    now: datetime | None = None,
    ttl: timedelta = DEFAULT_IDLE_TTL,
) -> dict:
    """返回本会话冻结的上下文；仅在首次/过期时调用业务 loader。

    ``load_context`` 返回已经渲染好的 prompt 输入，避免 runner、Web 各自维护一套
    snapshot 判断。函数不提交事务，由调用方和当前消息一起提交。
    """
    from app.core.events import get_context_revision

    current_revision = await get_context_revision(getattr(session, "user_id", None))
    if snapshot_is_usable(session, now, current_revision):
        _record_snapshot_event(session, "hit")
        return snapshot_context(session)

    payload = await load_context()
    initialize_snapshot(
        session,
        system_prompt=str(payload.get("system_prompt") or ""),
        dynamic_context=str(payload.get("dynamic_context") or ""),
        session_info=payload.get("session_info") or {},
        user_tz=payload.get("user_tz"),
        im_channels=payload.get("im_channels") or {},
        im_memory=payload.get("im_memory") or {},
        context_revision=current_revision,
        covered_messages=payload.get("covered_messages") or [],
        now=now,
        ttl=ttl,
    )
    await db.flush()
    _record_snapshot_event(session, "rebuild")
    return snapshot_context(session)
