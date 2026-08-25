"""Session snapshot 与唯一 baseline 的规范化 hash、TTL 和提交元数据。"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from app.core.tz import now_utc, resolve_tz, LOCAL_TZ

DEFAULT_IDLE_TTL = timedelta(minutes=30)


def date_boundary_note(hour: int) -> str:
    """仅说明日出前的日期指代规则，不引导模型对用户作息做判断。"""
    if hour >= 4:
        return ""
    return "；当前处于日出前时段，涉及日期时按日出边界理解：用户口中的「今天」指尚未结束的这个主观白天（日历昨天），「明天」指日出后的那天（日历今天）"


def _tz_storage_value(user_tz) -> str:
    """JSON 只保存 IANA 名称；服务器固定偏移统一记为 LOCAL。"""
    return getattr(user_tz, "key", None) or "LOCAL"


def current_time_text(user_tz=None) -> str:
    """生成每轮尾部的时间消息；它不进入 snapshot 前缀。"""
    current = datetime.now(user_tz or LOCAL_TZ)
    weekday = "一二三四五六日"[current.weekday()]
    text = f"{current:%Y-%m-%d}（星期{weekday}）{current:%H:%M}"
    text += date_boundary_note(current.hour)
    return text


def reminder_message(content: str) -> dict:
    """生成不带观测元数据的 reminder 消息。"""
    return {"role": "user", "content": f"[system-reminder]\n{content}\n[/system-reminder]"}


def snapshot_message(content: str) -> dict:
    """生成固定 session snapshot 消息。"""
    return {"role": "system", "content": f"[system-reminder]\n{content}\n[/system-reminder]"}


def message_time_reminder(sent_at, user_tz=None) -> dict | None:
    """把用户消息时间作为不可变的独立 reminder，按用户时区格式化。"""
    if sent_at is None:
        return None
    if sent_at.tzinfo is None:
        sent_at = sent_at.replace(tzinfo=timezone.utc)
    local_time = sent_at.astimezone(user_tz or LOCAL_TZ)
    return reminder_message(local_time.strftime("%m-%d %H:%M"))


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


def memory_summary_hash(memory: dict | None) -> str:
    """返回长期摘要的稳定指纹；只用于快照版本，不保存摘要正文。"""
    memory = memory or {}
    return digest({
        "summary": str(memory.get("summary") or "").strip(),
        "summary_ts": memory.get("summary_ts"),
    })


def snapshot_hash(system_hash: str, session_hash: str, covered_message_hash: str,
                  snapshot_context_hash: str = "") -> str:
    return digest({
        "system_hash": system_hash,
        "session_info_hash": session_hash,
        "covered_message_hash": covered_message_hash,
        "snapshot_context_hash": snapshot_context_hash,
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


def baseline_hash(messages: list) -> str:
    """生成压缩 baseline 的身份 hash，不把观测元数据带入。"""
    normalized = []
    for message in messages:
        raw = getattr(message, "content_json", None)
        if raw is None:
            raw = getattr(message, "content", "") or ""
        normalized.append({
            "id": getattr(message, "id", None),
            "role": getattr(message, "role", None),
            "content": raw,
        })
    return digest(normalized)


def snapshot_is_usable(session, now: datetime | None = None) -> bool:
    """判断当前 session 是否已有未过期的可复用 snapshot。"""
    context = getattr(session, "session_context", None)
    return bool(
        isinstance(context, dict)
        and context.get("system_prompt") is not None
        and context.get("session_info") is not None
        and not is_expired(session, now)
    )


def snapshot_context(session) -> dict:
    """读取已经冻结的 prompt 输入；调用方不得修改返回值后回写。"""
    context = getattr(session, "session_context", None) or {}
    return {
        "system_prompt": str(context.get("system_prompt") or ""),
        # 兼容旧 session_context；新快照统一使用能表达生命周期的字段名。
        "snapshot_context": str(
            context.get("snapshot_context")
            or context.get("dynamic_context")
            or ""
        ),
        "session_info": context.get("session_info") or {},
        "user_tz": resolve_tz(context.get("user_tz")) if context.get("user_tz") != "LOCAL" else LOCAL_TZ,
        "im_channels": context.get("im_channels") or {},
        "im_memory": context.get("im_memory") or {},
        "memory_summary_hash": str(context.get("memory_summary_hash") or ""),
        "history_baseline_message_id": int(
            context.get("history_baseline_message_id")
            or getattr(session, "baseline_message_id", 0)
            or 0
        ),
    }


def _set_rag_snapshot_context(text: str | None) -> None:
    """把 snapshot 的实际注入文本同步到当前请求，供 RAG 去重。"""
    try:
        from agent.rag.context import set_snapshot_context
        set_snapshot_context(text)
    except Exception:
        # RAG 观测/去重状态不可用时不影响主上下文组装。
        pass


def history_baseline(session) -> int:
    """返回 snapshot 与压缩水位中较新的历史边界。

    旧 session 没有 snapshot 边界时回退到 ``baseline_message_id``；不能凭空
    丢弃未进入 summary 的历史，因此默认 0 仍表示完整连续历史。
    """
    context = getattr(session, "session_context", None) or {}
    return max(
        int(getattr(session, "baseline_message_id", 0) or 0),
        int(context.get("history_baseline_message_id", 0) or 0),
    )


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


def record_baseline_update(session) -> None:
    """发布 baseline 已更新事件；正文仍只保留在数据库，不进入观测日志。"""
    _record_snapshot_event(session, "baseline_update")


def initialize_snapshot(
    session,
    *,
    system_prompt: str,
    snapshot_context: str,
    session_info: dict,
    user_tz: str | None,
    im_channels: dict | None = None,
    im_memory: dict | None = None,
    context_revision: int = 0,
    memory_summary_hash: str = "",
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
        "snapshot_context": snapshot_context,
        "session_info": session_info,
        "user_tz": _tz_storage_value(user_tz),
        "im_channels": im_channels or {},
        "im_memory": im_memory or {},
        "context_revision": context_revision,
        "memory_summary_hash": memory_summary_hash,
        "snapshot_context_hash": digest(snapshot_context),
        "history_baseline_message_id": int(getattr(session, "baseline_message_id", 0) or 0),
    }
    _set_rag_snapshot_context(snapshot_context)
    session.session_info_hash = info_hash
    session.snapshot_hash = snapshot_hash(
        digest(system_prompt),
        info_hash,
        message_hash(covered_messages or []),
        digest(snapshot_context),
    )
    session.snapshot_expires_at = current + ttl
    return session.snapshot_hash


def update_baseline_snapshot(
    session,
    messages: list[dict],
    *,
    baseline_message_id: int | None = None,
    now: datetime | None = None,
    ttl: timedelta = DEFAULT_IDLE_TTL,
) -> str:
    """将已覆盖消息纳入唯一 baseline 的 snapshot hash，并刷新 idle TTL。"""
    context = snapshot_context(session)
    stored_context = dict(getattr(session, "session_context", None) or {})
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
    context["history_baseline_message_id"] = int(
        getattr(session, "baseline_message_id", 0)
        if baseline_message_id is None
        else baseline_message_id
    )
    next_revision = int(stored_context.get("context_revision", 0) or 0) + 1
    context["context_revision"] = next_revision
    stored_context["history_baseline_message_id"] = context["history_baseline_message_id"]
    stored_context["context_revision"] = next_revision
    session.session_context = stored_context
    session.context_epoch = int(getattr(session, "context_epoch", 0) or 0) + 1
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
    if snapshot_is_usable(session, now):
        _record_snapshot_event(session, "hit")
        context = snapshot_context(session)
        _set_rag_snapshot_context(context["snapshot_context"])
        return context

    # revision 只记录本次 snapshot 已吸收的业务版本；普通业务变化先作为
    # pending 保留，不参与 hit/rebuild 判断，避免每次记忆或项目更新都打断缓存。
    from app.core.events import get_context_revision

    current_revision = await get_context_revision(getattr(session, "user_id", None))
    payload = await load_context()
    initialize_snapshot(
        session,
        system_prompt=str(payload.get("system_prompt") or ""),
        snapshot_context=str(
            payload.get("snapshot_context")
            or payload.get("dynamic_context")
            or ""
        ),
        session_info=payload.get("session_info") or {},
        user_tz=payload.get("user_tz"),
        im_channels=payload.get("im_channels") or {},
        im_memory=payload.get("im_memory") or {},
        memory_summary_hash=str(payload.get("memory_summary_hash") or ""),
        context_revision=current_revision,
        covered_messages=payload.get("covered_messages") or [],
        now=now,
        ttl=ttl,
    )
    await db.flush()
    _record_snapshot_event(session, "rebuild")
    return snapshot_context(session)
