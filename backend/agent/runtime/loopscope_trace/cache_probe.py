"""LoopScope 内的缓存突降触发与归因规则；只处理结构元数据，不记录正文。"""
from __future__ import annotations

import json
import uuid
from typing import Any

from .utils import _estimate_tokens, _prompt_digest

MIN_PREFIX_TOKENS = 32_000
MIN_PREVIOUS_HIT_RATIO = 0.50
MAX_CURRENT_HIT_RATIO = 0.05
MIN_DROP_RATIO = 0.80
LONG_GAP_SECONDS = 300.0
_REFLECTION_TRIGGER_SOURCES = frozenset({
    "threshold", "idle", "background_job", "session_snapshot", "direct", "unknown",
})
_REFLECTION_SCOPES = frozenset({"owner", "private", "group", "member", "unknown"})


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
    from agent.context.provider_conversation import ProviderConversation
    if not isinstance(messages, ProviderConversation):
        raise TypeError("LoopScope summary probe 只接受 ProviderConversation")
    conversation = messages.conversation
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
        "stable_prefix_tokens_estimate": int(
            cache_diag.get("stable_prefix_tokens_estimate", 0)
            or cache_diag.get("cache_anchor_tokens_estimate", 0)
            or 0
        ),
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
            int(previous.get(
                "stable_prefix_tokens_estimate", previous.get("stable_prefix_tokens", 0),
            ) or 0),
            int(current.get(
                "stable_prefix_tokens_estimate", current.get("stable_prefix_tokens", 0),
            ) or 0),
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
        "cache_write_tokens", "cache_hit_ratio", "stable_prefix_tokens_estimate",
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


def build_reflection_sample(
    branch_input: Any, ai: Any, adapter: Any, usage: dict[str, Any],
    attempt_index: int = 1, request_probe: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """构造反思请求缓存样本；只输出 token、计数与指纹，不输出任何正文。"""
    stable_system = branch_input.stable_system
    history_messages = branch_input.history_messages
    from agent.context.provider_conversation import ProviderConversation

    if isinstance(history_messages, ProviderConversation):
        history_messages = history_messages.to_messages()
    tools = branch_input.tools
    trigger_context = branch_input.cache_probe_context or {}
    model = str(getattr(ai, "model", "") or "")
    provider = str(getattr(adapter, "name", "unknown") or "unknown")
    api_format = str(adapter.protocol_format(ai) or "unknown")
    prefix = {
        "system": stable_system or "",
        "history": history_messages or (),
        "tools": tools or (),
    }
    cache_read = _nonnegative_int(usage.get("cache_read"))
    cache_write = _nonnegative_int(usage.get("cache_write"))
    if "fresh_input" in usage:
        # Provider normalizers expose uncached, non-write tokens explicitly.
        fresh_input = _nonnegative_int(usage.get("fresh_input"))
        input_tokens = fresh_input + cache_read + cache_write
    else:
        # Legacy/manual samples use input as the complete prompt total.
        input_tokens = _nonnegative_int(usage.get("input"))
        fresh_input = max(0, input_tokens - cache_read - cache_write)
    ratio = cache_read / input_tokens if input_tokens else 0.0
    # _estimate_tokens 的对象路径使用 trace 展示裁剪，不能拿裁剪后的前缀判断告警资格。
    prefix_json = json.dumps(prefix, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    prefix_tokens = _estimate_tokens(prefix_json, model)
    supported = bool(adapter.supports_active_cache(model))
    eligible = supported and prefix_tokens >= MIN_PREFIX_TOKENS
    source = trigger_context.get("trigger_source", "unknown")
    if source not in _REFLECTION_TRIGGER_SOURCES:
        source = "unknown"
    reflection_scope = trigger_context.get("reflection_scope", "unknown")
    if reflection_scope not in _REFLECTION_SCOPES:
        reflection_scope = "unknown"
    gap = trigger_context.get("origin_gap_seconds")
    try:
        gap_seconds = round(max(float(gap), 0.0), 3) if gap is not None else None
    except (TypeError, ValueError):
        gap_seconds = None
    history = history_messages or ()
    tool_list = tools or ()
    request_probe = request_probe if isinstance(request_probe, dict) else {}
    return {
        "schema_version": 1,
        "scenario": "reflection",
        "provider": _safe_label(provider),
        "model": _safe_label(model),
        "api_format": _safe_label(api_format),
        "cache_supported": supported,
        "input_tokens": input_tokens,
        "fresh_input_tokens": fresh_input,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "cache_hit_ratio": round(ratio, 6),
        "stable_prefix_tokens_estimate": prefix_tokens,
        "stable_prefix_digest": _prompt_digest(prefix_json),
        "system_digest": _prompt_digest(stable_system or ""),
        "tool_schema_digest": _prompt_digest(tool_list),
        "history_message_count": len(history) if hasattr(history, "__len__") else 0,
        "tool_count": len(tool_list) if hasattr(tool_list, "__len__") else 0,
        "reflection_scope": reflection_scope,
        "trigger_source": source,
        "origin_run_id": _safe_label(trigger_context.get("origin_run_id")),
        "origin_gap_seconds": gap_seconds,
        "snapshot_source": trigger_context.get("snapshot_source", "unavailable"),
        "probe_eligible": eligible,
        "cache_low_hit": (
            eligible and ratio <= MAX_CURRENT_HIT_RATIO
            and request_probe.get("outcome", "success") != "error"
        ),
        "attempt_index": max(1, _nonnegative_int(attempt_index)),
        "request_started_at": request_probe.get("request_started_at"),
        "response_received_at": request_probe.get("response_received_at"),
        "request_duration_ms": request_probe.get("request_duration_ms"),
        "wire_prefix": request_probe.get("wire_prefix"),
        "raw_usage_probe": request_probe.get("raw_usage"),
        "request_outcome": request_probe.get("outcome", "unknown"),
        "request_error_type": request_probe.get("error_type"),
        "request_error_status": request_probe.get("error_status"),
        "request_error_code": request_probe.get("error_code"),
    }


def record_reflection_usage(
    policy_name: str, branch_input: Any, settings: Any, usage_samples: list,
    request_samples: list | None = None,
) -> None:
    """记录 append 分支实际 usage；遥测错误只进入受限诊断，不影响反思结果。"""
    if policy_name != "reflection" or not (usage_samples or request_samples):
        return
    from . import state

    if not state._enabled():
        return
    try:
        from agent import providers
        from agent.llm.modelctx import effective_ai

        ai = effective_ai(settings)
        adapter = providers.adapter_for(ai)
        probe_rows = [item for item in (request_samples or []) if isinstance(item, dict)]
        samples = (
            [(item.get("normalized_usage") or {}, item) for item in probe_rows]
            if probe_rows else [(usage, None) for usage in usage_samples]
        )
        for index, (usage, request_probe) in enumerate(samples, start=1):
            observation = build_reflection_sample(
                branch_input, ai, adapter, usage, attempt_index=index,
                request_probe=request_probe,
            )
            record_reflection_sample(
                observation, session_id=branch_input.session_id,
            )
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.runtime.loopscope_trace.reflection_cache_probe", exc)


def record_compaction_probe(
    branch_input: Any, settings: Any, attempts: list[dict[str, Any]],
) -> None:
    """将压缩分支真实请求体和 provider 原始 usage 保存到受控 LoopScope trace。"""
    from . import state

    if not attempts or not state._enabled():
        return
    try:
        from agent import providers
        from agent.llm.modelctx import effective_ai

        ai = effective_ai(settings)
        adapter = providers.adapter_for(ai)
        model = _safe_label(getattr(ai, "model", ""))
        provider = _safe_label(getattr(adapter, "name", "unknown"))
        api_format = _safe_label(adapter.protocol_format(ai))
        run = state._scope_run.get()
        detached = run is None or run.ended_at is not None
        if detached:
            trace_id = uuid.uuid4().hex[:12]
            session_text = str(branch_input.session_id) if branch_input.session_id is not None else "unknown"
            run = state._ScopeRun(
                id=f"run-{trace_id}-{uuid.uuid4().hex[:6]}",
                trace_id=trace_id,
                session_key=f"gugu:compaction:{session_text}",
                external_session_id=session_text,
                source="compaction",
                started_at=state._now(),
            )
            run.attributes["scenario"] = "compaction"
            if branch_input.run_id:
                run.attributes["origin_run_id"] = _safe_label(branch_input.run_id)

        observations = run.attributes.setdefault("compaction_probe", {
            "schema_version": 1, "attempt_count": 0, "attempts": [],
        })
        for index, attempt in enumerate(attempts, start=1):
            raw_usage = attempt.get("raw_usage")
            normalized = attempt.get("normalized_usage") or {}
            cache_fields = _cache_usage_fields(raw_usage)
            request = attempt.get("request")
            summary = {
                "attempt_index": index,
                "provider": provider,
                "model": model,
                "api_format": api_format,
                "request_captured": isinstance(request, dict),
                "raw_usage_captured": raw_usage is not None,
                "cache_usage_fields": cache_fields,
                "normalized_usage": normalized,
            }
            span = run.span(
                "llm",
                "Compaction provider cache probe",
                {"scenario": "compaction", **summary, "provider_request": request or {}},
                token_impact={
                    "prompt_tokens_actual": _nonnegative_int(normalized.get("input")),
                    "cache_read_tokens": _nonnegative_int(normalized.get("cache_read")),
                    "cache_write_tokens": _nonnegative_int(normalized.get("cache_write")),
                },
                scenario="compaction",
                provider=provider,
                model=model,
                api_format=api_format,
                attempt_index=index,
            )
            span.usage = dict(normalized) if isinstance(normalized, dict) else {}
            span.finish({
                "raw_provider_usage": raw_usage,
                "normalized_usage": normalized,
                "cache_usage_fields": cache_fields,
            }, status="success" if raw_usage is not None else "error")
            observations["attempt_count"] = int(observations.get("attempt_count", 0) or 0) + 1
            observations.setdefault("attempts", []).append(summary)
        del observations["attempts"][:-10]
        if detached:
            for attempt in attempts:
                usage = attempt.get("normalized_usage")
                if isinstance(usage, dict):
                    run.add_usage(usage)
            state._finish_run(
                run,
                "success" if any(attempt.get("raw_usage") is not None for attempt in attempts)
                else "error",
            )
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.runtime.loopscope_trace.compaction_probe", exc)


def _cache_usage_fields(raw_usage: Any) -> dict[str, Any]:
    """返回原始 usage 中所有 cache 字段；空对象表示 provider 未上报相关字段。"""
    if hasattr(raw_usage, "model_dump"):
        try:
            raw_usage = raw_usage.model_dump(exclude_none=False)
        except Exception:
            pass
    elif hasattr(raw_usage, "__dict__") and not isinstance(raw_usage, dict):
        raw_usage = vars(raw_usage)
    found: dict[str, Any] = {}

    def visit(value: Any, prefix: str = "") -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                path = f"{prefix}.{key}" if prefix else str(key)
                if "cache" in str(key).lower():
                    found[path] = item
                if isinstance(item, dict):
                    visit(item, path)

    visit(raw_usage)
    return found


def record_reflection_sample(
    observation: dict[str, Any], *, session_id: int | None,
) -> None:
    """把反思缓存样本写入活动 trace；闲置后台反思使用独立精简 trace。"""
    from . import state

    if not state._enabled():
        return
    safe = _safe_reflection_observation(observation)
    if not safe:
        return

    # Every sample gets its own reflection trace so the dedicated page can query
    # threshold and idle reflections consistently, regardless of the parent run.
    trace_id = uuid.uuid4().hex[:12]
    session_text = str(session_id) if session_id is not None else "unknown"
    run = state._ScopeRun(
        id=f"run-{trace_id}-{uuid.uuid4().hex[:6]}",
        trace_id=trace_id,
        session_key=f"gugu:reflection:{session_text}",
        external_session_id=session_text,
        source="reflection",
        started_at=state._now(),
    )
    run.attributes["scenario"] = "reflection"
    run.attributes["reflection_scope"] = safe["reflection_scope"]
    run.attributes["reflection_cache_probe"] = safe
    if safe.get("origin_run_id"):
        run.attributes["origin_run_id"] = safe["origin_run_id"]

    usage = {
        "input": safe["input_tokens"],
        "fresh_input": safe["fresh_input_tokens"],
        "cache_read": safe["cache_read_tokens"],
        "cache_write": safe["cache_write_tokens"],
        "cache_ratio": safe["cache_hit_ratio"],
    }
    span = run.span(
        "llm",
        "Reflection cache observation",
        {"reflection_cache_probe": safe},
        token_impact={
            "prompt_tokens_actual": safe["input_tokens"],
            "stable_prefix_tokens_estimate": safe["stable_prefix_tokens_estimate"],
            "cache_read_tokens": safe["cache_read_tokens"],
        },
        scenario="reflection",
        reflection_scope=safe["reflection_scope"],
        trigger_source=safe["trigger_source"],
        cache_low_hit=safe["cache_low_hit"],
    )
    span.usage = usage
    span.finish({
        "cache_hit_ratio": safe["cache_hit_ratio"],
        "probe_eligible": safe["probe_eligible"],
        "cache_low_hit": safe["cache_low_hit"],
    })

    bucket = run.attributes.setdefault("reflection_cache_probe", {
        "sample_count": 0, "low_hit_count": 0, "samples": [],
    })
    bucket["sample_count"] = int(bucket.get("sample_count", 0) or 0) + 1
    if safe["cache_low_hit"]:
        bucket["low_hit_count"] = int(bucket.get("low_hit_count", 0) or 0) + 1
    samples = bucket.setdefault("samples", [])
    samples.append({key: safe[key] for key in (
        "provider", "model", "api_format", "cache_hit_ratio",
        "stable_prefix_tokens_estimate", "reflection_scope", "trigger_source",
        "snapshot_source",
        "origin_gap_seconds", "cache_low_hit", "request_started_at",
        "request_duration_ms", "wire_prefix_digest", "wire_prefix_row_count",
        "wire_prefix_text_char_count",
    )})
    del samples[:-10]

    run.add_usage(usage)
    state._finish_run(run, "success")


def _nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def _safe_label(value: Any) -> str:
    text = str(value or "")
    return "".join(char for char in text if ord(char) >= 32)[:128]


def _safe_reflection_observation(value: dict[str, Any]) -> dict[str, Any]:
    """对写入 trace 的分支样本再做字段白名单，防止正文混入探针。"""
    if value.get("scenario") != "reflection":
        return {}
    has_fresh_input = value.get("fresh_input_tokens") is not None
    allowed = (
        "schema_version", "scenario", "provider", "model", "api_format",
        "cache_supported", "input_tokens", "fresh_input_tokens", "cache_read_tokens",
        "cache_write_tokens", "cache_hit_ratio", "stable_prefix_tokens_estimate",
        "stable_prefix_digest", "system_digest", "tool_schema_digest",
        "history_message_count", "tool_count", "reflection_scope", "trigger_source", "origin_run_id",
        "origin_gap_seconds", "snapshot_source", "probe_eligible", "cache_low_hit", "attempt_index",
        "request_started_at", "response_received_at", "request_duration_ms",
        "wire_prefix", "raw_usage_probe", "request_outcome", "request_error_type",
        "request_error_status", "request_error_code",
    )
    safe = {key: value[key] for key in allowed if key in value}
    for key in (
        "provider", "model", "api_format", "stable_prefix_digest", "system_digest",
        "tool_schema_digest",
    ):
        safe[key] = _safe_label(safe.get(key, ""))
    safe["origin_run_id"] = _safe_label(safe.get("origin_run_id"))
    source = safe.get("trigger_source")
    safe["trigger_source"] = source if source in _REFLECTION_TRIGGER_SOURCES else "unknown"
    scope = safe.get("reflection_scope")
    safe["reflection_scope"] = scope if scope in _REFLECTION_SCOPES else "unknown"
    snapshot_source = safe.get("snapshot_source")
    safe["snapshot_source"] = (
        snapshot_source if snapshot_source in {
            "in_memory", "in_memory_extended", "persisted_history", "unavailable",
        }
        else "other"
    )
    for key in (
        "schema_version", "input_tokens", "fresh_input_tokens", "cache_read_tokens",
        "cache_write_tokens", "stable_prefix_tokens_estimate", "history_message_count",
        "tool_count", "attempt_index",
    ):
        safe[key] = _nonnegative_int(safe.get(key))
    for key in ("request_started_at", "response_received_at"):
        value = safe.get(key)
        safe[key] = value[:64] if isinstance(value, str) else None
    try:
        safe["request_duration_ms"] = round(max(0.0, float(safe.get("request_duration_ms"))), 3)
    except (TypeError, ValueError):
        safe["request_duration_ms"] = None
    outcome = safe.get("request_outcome")
    safe["request_outcome"] = outcome if outcome in {"success", "error"} else "unknown"
    safe["request_error_type"] = _safe_label(safe.get("request_error_type", ""))
    status = safe.get("request_error_status")
    safe["request_error_status"] = status if isinstance(status, int) and 100 <= status <= 599 else None
    code = safe.get("request_error_code")
    safe["request_error_code"] = _safe_label(code) if isinstance(code, str) else ""
    wire_prefix = safe.get("wire_prefix")
    if isinstance(wire_prefix, dict):
        allowed_wire = {
            "digest", "rows_key", "prefix_row_count", "request_row_count",
            "text_block_count", "text_char_count", "anchor_paths", "anchor_index_basis",
        }
        wire = {key: wire_prefix[key] for key in allowed_wire if key in wire_prefix}
        wire["digest"] = _safe_label(wire.get("digest", ""))
        wire["rows_key"] = wire.get("rows_key") if wire.get("rows_key") in {"messages", "input"} else None
        wire["anchor_paths"] = [
            _safe_label(path) for path in wire.get("anchor_paths", []) if isinstance(path, str)
        ][:32]
        for key in ("prefix_row_count", "request_row_count", "text_block_count", "text_char_count"):
            wire[key] = _nonnegative_int(wire.get(key))
        wire["anchor_index_basis"] = "wire row index; paths identify nested block positions"
        safe["wire_prefix"] = wire
    else:
        safe["wire_prefix"] = {}
    raw_usage = safe.get("raw_usage_probe")
    def numeric_usage_shape(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                _safe_label(str(key)): numeric_usage_shape(item)
                for key, item in value.items()
                if isinstance(key, str) and isinstance(item, (dict, list, int, float, bool))
            }
        if isinstance(value, list):
            return [numeric_usage_shape(item) for item in value[:64]
                    if isinstance(item, (dict, list, int, float, bool))]
        return value if isinstance(value, (int, float, bool)) else None

    safe["raw_usage_probe"] = numeric_usage_shape(raw_usage) if isinstance(raw_usage, dict) else None
    if not has_fresh_input:
        safe["fresh_input_tokens"] = max(
            0,
            safe["input_tokens"] - safe["cache_read_tokens"] - safe["cache_write_tokens"],
        )
    input_total = (
        safe["fresh_input_tokens"]
        + safe["cache_read_tokens"]
        + safe["cache_write_tokens"]
    )
    safe["input_tokens"] = input_total
    safe["cache_hit_ratio"] = (
        round(safe["cache_read_tokens"] / input_total, 6) if input_total else 0.0
    )
    try:
        gap = safe.get("origin_gap_seconds")
        safe["origin_gap_seconds"] = round(max(float(gap), 0), 3) if gap is not None else None
    except (TypeError, ValueError):
        safe["origin_gap_seconds"] = None
    for key in ("cache_supported", "probe_eligible", "cache_low_hit"):
        safe[key] = bool(safe.get(key))
    safe["cache_low_hit"] = (
        safe["probe_eligible"]
        and safe["cache_hit_ratio"] <= MAX_CURRENT_HIT_RATIO
        and safe["request_outcome"] != "error"
    )
    safe["scenario"] = "reflection"
    safe["wire_prefix_digest"] = safe["wire_prefix"].get("digest")
    safe["wire_prefix_row_count"] = safe["wire_prefix"].get("prefix_row_count", 0)
    safe["wire_prefix_text_char_count"] = safe["wire_prefix"].get("text_char_count", 0)
    return safe
