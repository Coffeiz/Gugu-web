"""上下文边界变化审计日志。

这里只记录长度、指纹和作用域元数据，不记录摘要正文、消息正文或用户输入。
用于定位 cache 前缀变化究竟来自压缩、会话摘要还是记忆反思。
"""
from __future__ import annotations

import hashlib
import logging
from contextvars import ContextVar
from typing import Any

from agent.security.logsafe import fingerprint

logger = logging.getLogger("agent.context.audit")
_pending_layout: ContextVar[dict[str, Any] | None] = ContextVar(
    "context_layout_probe", default=None,
)


def _fp(value: Any) -> str:
    return fingerprint("" if value is None else str(value))


def _message_probe(message: Any) -> dict[str, Any]:
    """返回消息的脱敏结构指纹，禁止把正文写入诊断日志。"""
    role = message.get("role") if isinstance(message, dict) else getattr(message, "role", "")
    content = message.get("content") if isinstance(message, dict) else getattr(message, "content", "")
    blocks = content if isinstance(content, list) else [content]
    block_meta: list[dict[str, Any]] = []
    markers: list[str] = []
    for block in blocks:
        if isinstance(block, dict):
            kind = str(block.get("type") or "text")
            value = block.get("text") or block.get("content") or ""
        else:
            kind = "text"
            value = "" if block is None else str(block)
        value = str(value)
        for marker in (
            "[system-reminder]", "[群聊历史消息", "[当前群聊发言人", "[group-rag]",
            "[owner-rag]", "[group-member-rag]", "[knowledge-context]",
            "## 当前群组记忆", "## 当前 IM 身份事实", "## 默认相处姿态", "当前时间：",
        ):
            if marker in value:
                markers.append(marker)
        block_meta.append({"type": kind, "len": len(value), "fp": _fp(value)})
    return {"role": role, "blocks": block_meta, "markers": markers}


def context_layout_probe(*, phase: str, session: Any, snapshot: dict[str, Any] | None,
                         history: list[Any], messages: list[Any] | None = None,
                         fixed_prefix_count: int | None = None,
                         dynamic_tail_count: int | None = None,
                         history_stats: dict[str, Any] | None = None,
                         sanitize_before_count: int | None = None,
                         sanitize_after_count: int | None = None,
                         merged_cross_segment: bool | None = None) -> None:
    """记录 snapshot/baseline/history 的边界和最终顺序，不记录正文。"""
    snapshot = snapshot or {}
    snapshot_context = str(snapshot.get("snapshot_context") or "")
    history_meta = [_message_probe(item) for item in history]
    sequence = [_message_probe(item) for item in (messages or [])]
    sequence_json = repr(sequence).encode("utf-8")
    session_baseline = int(getattr(session, "baseline_message_id", 0) or 0)
    snapshot_baseline = int(
        (snapshot.get("context") or {}).get("history_baseline_message_id", 0)
        or snapshot.get("history_baseline_message_id", 0)
        or 0
    )
    payload = {
        **session_scope(session),
        "phase": phase,
        "baseline_id": session_baseline,
        "snapshot_baseline_id": snapshot_baseline,
        "baseline_delta": session_baseline - snapshot_baseline,
        "snapshot_hash_fp": _fp(snapshot.get("snapshot_hash")),
        "snapshot_context_len": len(snapshot_context),
        "snapshot_markers": sorted({marker for item in [_message_probe({"content": snapshot_context})]
                                      for marker in item["markers"]}),
        "history_count": len(history_meta),
        "history_head": history_meta[:3],
        "history_tail": history_meta[-3:],
        "history_sequence_fp": _fp(repr(history_meta)),
        "message_count": len(sequence),
        "message_sequence_fp": hashlib.sha1(sequence_json).hexdigest()[:12],
        "message_head": sequence[:3],
        "message_tail": sequence[-3:],
        "fixed_prefix_count": fixed_prefix_count,
        "dynamic_tail_count": dynamic_tail_count,
        "history_loaded_count": (history_stats or {}).get("history_loaded_count"),
        "history_selected_count": (history_stats or {}).get("history_selected_count", len(history_meta)),
        "history_summary_count": (history_stats or {}).get("history_summary_count"),
        "history_baseline_message_id": (history_stats or {}).get("history_baseline_message_id"),
        "history_oldest_selected_id": (history_stats or {}).get("history_oldest_selected_id"),
        "history_newest_selected_id": (history_stats or {}).get("history_newest_selected_id"),
        "sanitize_before_count": sanitize_before_count,
        "sanitize_after_count": sanitize_after_count,
        "merged_cross_segment": merged_cross_segment,
    }
    # 只在当前任务内暂存一次组装边界，最终由 LoopScope 的 provider 入口消费。
    # 这样诊断不会停留在 history-loaded 等中间态，也不会把 web/IM 分成两套探针。
    _pending_layout.set(payload)
    logger.info(
        "[context-layout] %s %s",
        phase, payload,
    )


def consume_context_layout_probe() -> dict[str, Any] | None:
    """取出当前任务最近一次应用层组装边界，供统一 provider 入口对照。"""
    payload = _pending_layout.get()
    _pending_layout.set(None)
    return payload


def session_scope(session: Any) -> dict[str, Any]:
    """提取可安全记录的会话作用域元数据。"""
    return {
        "session_id": getattr(session, "id", None),
        "source": getattr(session, "source", None),
        "chat_type": getattr(session, "chat_type", None),
        "chat_id_fp": _fp(getattr(session, "chat_id", None)),
        "bot_id_fp": _fp(getattr(session, "bot_id", None)),
        "user_id_fp": _fp(getattr(session, "user_id", None)),
    }


def summary_change(*, source: str, old: str | None, new: str | None, **fields: Any) -> None:
    """记录摘要变更，不打印摘要正文。"""
    logger.info(
        "[context-summary-audit] %s old_len=%d new_len=%d old_fp=%s new_fp=%s %s",
        source,
        len(old or ""),
        len(new or ""),
        fingerprint(old or ""),
        fingerprint(new or ""),
        " ".join(f"{key}={value}" for key, value in fields.items() if value is not None),
    )


def provider_history_change(*, session: Any, previous_provider: str | None,
                            previous_api_format: str | None, provider: str,
                            api_format: str, stripped: bool) -> None:
    """记录历史协议边界变化；不记录消息正文或用户标识。"""
    logger.info(
        "[context-provider-history] session=%s old_provider=%s old_format=%s "
        "provider=%s api_format=%s stripped=%s %s",
        getattr(session, "id", None), previous_provider or "unknown",
        previous_api_format or "unknown", provider, api_format, stripped,
        " ".join(f"{key}={value}" for key, value in session_scope(session).items()
                 if key not in {"session_id"}),
    )
