"""LoopScope 内的缓存突降触发与归因规则；只处理结构元数据，不记录正文。"""
from __future__ import annotations

from typing import Any

from .utils import _prompt_digest

MIN_PREFIX_TOKENS = 32_000
MIN_PREVIOUS_HIT_RATIO = 0.50
MAX_CURRENT_HIT_RATIO = 0.05
MIN_DROP_RATIO = 0.80
LONG_GAP_SECONDS = 300.0


def context_digests(messages: Any, run: Any) -> dict[str, Any]:
    """提取 memory/summary 是否存在及其指纹，绝不把正文返回给调用方。"""
    memory_values = _memory_values(run)
    summary_values = _summary_values(messages)
    return {
        "memory_injected": bool(memory_values),
        "memory_digest": _digest(memory_values),
        "summary_digest": _digest(summary_values),
    }


def _memory_values(run: Any) -> list[Any]:
    values = []
    for span in [*run.spans, *run.pending_context_spans]:
        attrs = getattr(span, "attributes", {}) or {}
        name = str(getattr(span, "name", ""))
        if attrs.get("context_source") and (
            attrs.get("source") == "memory" or name.startswith("Memory ·")
        ):
            values.append(getattr(span, "output", {}))
    return values


def _summary_values(messages: Any) -> list[str]:
    conversation = getattr(messages, "conversation", messages)
    found = []
    for message in conversation if isinstance(conversation, list) else ():
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str) and "<compacted-summary>" in content:
            found.append(content)
        elif isinstance(content, list):
            found.extend(
                text for block in content
                if isinstance(block, dict)
                for text in [str(block.get("text") or block.get("content") or "")]
                if "<compacted-summary>" in text
            )
    return found


def _digest(value: Any) -> str:
    return _prompt_digest(value) if value else ""


def build_cache_round(*, at: float, provider: str, model: str, api_format: str,
                      cache_diag: dict[str, Any], usage: dict[str, Any],
                      system_digest: str, context: dict[str, Any],
                      prefix_unchanged: bool | None) -> dict[str, Any]:
    """生成只含 usage、指纹和结构变化的单轮快照。"""
    return {
        "at": at,
        "provider": provider,
        "model": model,
        "api_format": api_format,
        "cache_supported": bool(cache_diag.get("cache_supported")),
        "input_tokens": int(usage.get("input", 0) or 0),
        "cache_read_tokens": int(usage.get("cache_read", 0) or 0),
        "cache_write_tokens": int(usage.get("cache_write", 0) or 0),
        "cache_hit_ratio": float(usage.get("cache_ratio", 0) or 0),
        "stable_prefix_tokens": int(cache_diag.get("cache_anchor_tokens_estimate", 0) or 0),
        "stable_prefix_digest": str(cache_diag.get("cache_prefix_digest", "") or ""),
        "stable_message_count": int(cache_diag.get("stable_message_count", 0) or 0),
        "prefix_unchanged": prefix_unchanged,
        "tool_schema_digest": str(cache_diag.get("tool_schema_digest", "") or ""),
        "system_digest": system_digest,
        **context,
    }


def prefix_unchanged(previous: dict[str, Any] | None,
                     diagnostics: dict[str, Any]) -> bool | None:
    """按前一轮的稳定消息边界判断共同前缀是否仍完整。"""
    if not previous or not diagnostics.get("available"):
        return None
    first_diff = diagnostics.get("first_diff_index")
    previous_stable_count = int(previous.get("stable_message_count", 0) or 0)
    return first_diff is None or int(first_diff) >= previous_stable_count


def detect_cache_drop(previous: dict[str, Any] | None,
                      current: dict[str, Any]) -> dict[str, Any] | None:
    """命中率显著下跌时返回无正文的对比事件；冷启动和小前缀不触发。"""
    if not _eligible(previous, current):
        return None
    previous_ratio = float(previous.get("cache_hit_ratio", 0) or 0)
    current_ratio = float(current.get("cache_hit_ratio", 0) or 0)
    if not _is_drop(previous_ratio, current_ratio):
        return None
    gap = max(0.0, float(current.get("at", 0) or 0) - float(previous.get("at", 0) or 0))
    attribution = _attribution(previous, current, gap)
    return _event(previous, current, gap, previous_ratio - current_ratio, attribution)


def _eligible(previous: dict[str, Any] | None, current: dict[str, Any]) -> bool:
    return bool(
        previous
        and previous.get("cache_supported")
        and current.get("cache_supported")
        and min(
            int(previous.get("stable_prefix_tokens", 0) or 0),
            int(current.get("stable_prefix_tokens", 0) or 0),
        ) >= MIN_PREFIX_TOKENS
        and float(previous.get("cache_hit_ratio", 0) or 0) >= MIN_PREVIOUS_HIT_RATIO
    )


def _is_drop(previous_ratio: float, current_ratio: float) -> bool:
    return (
        current_ratio <= MAX_CURRENT_HIT_RATIO
        or previous_ratio - current_ratio >= MIN_DROP_RATIO
    )


def _attribution(previous: dict[str, Any], current: dict[str, Any], gap: float) -> list[str]:
    checks = (
        (not _prefix_matches(previous, current), "prefix_changed"),
        (previous.get("tool_schema_digest") != current.get("tool_schema_digest"), "tool_schema_changed"),
        (previous.get("system_digest") != current.get("system_digest"), "system_prompt_changed"),
        (previous.get("memory_digest") != current.get("memory_digest"), "memory_changed"),
        (previous.get("summary_digest") != current.get("summary_digest"), "summary_changed"),
        (previous.get("provider") != current.get("provider"), "provider_changed"),
        (previous.get("model") != current.get("model"), "model_changed"),
        (previous.get("api_format") != current.get("api_format"), "api_format_changed"),
        (gap >= LONG_GAP_SECONDS, "time_gap_suspected"),
    )
    reasons = [reason for matched, reason in checks if matched]
    return reasons or ["provider_cache_drop_unexplained"]


def _prefix_matches(previous: dict[str, Any], current: dict[str, Any]) -> bool:
    matches = current.get("prefix_unchanged")
    if isinstance(matches, bool):
        return matches
    return previous.get("stable_prefix_digest") == current.get("stable_prefix_digest")


def _event(previous: dict[str, Any], current: dict[str, Any], gap: float,
           drop: float, attribution: list[str]) -> dict[str, Any]:
    return {
        "previous": _usage_snapshot(previous),
        "current": _usage_snapshot(current),
        "request_gap_seconds": round(gap, 3),
        "hit_ratio_drop": round(drop, 6),
        "prefix_unchanged": _prefix_matches(previous, current),
        "tool_schema_changed": "tool_schema_changed" in attribution,
        "system_prompt_changed": "system_prompt_changed" in attribution,
        "provider_changed": "provider_changed" in attribution,
        "model_changed": "model_changed" in attribution,
        "api_format_changed": "api_format_changed" in attribution,
        "memory_injected": bool(current.get("memory_injected")),
        "memory_changed": "memory_changed" in attribution,
        "summary_changed": "summary_changed" in attribution,
        "attribution": attribution,
    }


def _usage_snapshot(value: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "provider", "model", "api_format", "input_tokens", "cache_read_tokens",
        "cache_write_tokens", "cache_hit_ratio", "stable_prefix_tokens",
        "stable_prefix_digest", "tool_schema_digest", "system_digest",
        "memory_digest", "summary_digest",
    )
    return {key: value.get(key) for key in keys}


def record_cache_drop(run: Any, span: Any, previous: dict[str, Any] | None,
                      current: dict[str, Any]) -> None:
    """只在突降时保存一次详情，后续异常仅增加计数。"""
    event = detect_cache_drop(previous, current)
    if event is None:
        return
    probe = run.attributes.setdefault("cache_drop_probe", {"event_count": 0, "events": []})
    probe["event_count"] = int(probe.get("event_count", 0) or 0) + 1
    if not probe["events"]:
        probe["events"].append(event)
        span.attributes["cache_drop_probe"] = event
