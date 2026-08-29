from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import os
import time
import urllib.request
import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from .utils import _code_ref, _estimate_tokens, _jsonable

_trace: ContextVar[str] = ContextVar("trace_id", default="")
_scope_run: ContextVar["_ScopeRun | None"] = ContextVar("loopscope_run", default=None)
_send_tasks: set[asyncio.Task] = set()
_layout_logger = logging.getLogger("agent.core")

def _enabled() -> bool:
    return os.getenv("LOOPSCOPE_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}

def _now() -> float:
    return time.time()


def _diagnostic_bucket(run: "_ScopeRun", key: str, default: dict[str, Any]) -> dict[str, Any]:
    value = run.attributes.get(key)
    if not isinstance(value, dict):
        value = copy.deepcopy(default)
        run.attributes[key] = value
    return value


def record_canonical_event_stats(run: "_ScopeRun", stats: dict[str, Any]) -> None:
    """记录最近一次 provider 输入中的 canonical event 统计。"""
    bucket = _diagnostic_bucket(run, "canonical_events", {
        "count": 0, "by_type": {}, "schema_digests": [],
    })
    bucket["count"] = int(stats.get("count", 0) or 0)
    bucket["by_type"] = dict(stats.get("by_type") or {})
    bucket["schema_digests"] = sorted({str(item) for item in stats.get("schema_digests") or () if item})


def record_canonical_batch(*, digest: str, round_id: str | None, message_count: int) -> None:
    """记录已提交 canonical batch 的脱敏身份，便于核对持久化与请求投影。"""
    run = _scope_run.get()
    if run is None or run.ended_at is not None:
        return
    bucket = _diagnostic_bucket(run, "canonical_batches", {
        "count": 0, "digests": [], "round_ids": [], "message_count": 0,
    })
    bucket["count"] = int(bucket.get("count", 0) or 0) + 1
    bucket["message_count"] = int(bucket.get("message_count", 0) or 0) + int(message_count or 0)
    if digest:
        bucket["digests"] = sorted({*bucket.get("digests", []), str(digest)})
    if round_id:
        bucket["round_ids"] = sorted({*bucket.get("round_ids", []), str(round_id)})


def record_context_compaction(
    *,
    phase: str,
    reason: str,
    changed: bool,
    before_messages: int,
    after_messages: int,
    before_summary_count: int = 0,
    after_summary_count: int = 0,
    before_summary_chars: int = 0,
    after_summary_chars: int = 0,
    protected_from: int | None = None,
) -> None:
    """记录一次上下文压缩结果，不记录历史正文。"""
    run = _scope_run.get()
    if run is None or run.ended_at is not None:
        return
    payload = {
        "phase": phase,
        "reason": reason,
        "changed": bool(changed),
        "before_messages": int(before_messages),
        "after_messages": int(after_messages),
        "before_summary_count": int(before_summary_count),
        "after_summary_count": int(after_summary_count),
        "before_summary_chars": int(before_summary_chars),
        "after_summary_chars": int(after_summary_chars),
        "protected_from": protected_from,
    }
    span = run.span("context", "Context compaction", payload, context_source="compaction")
    span.finish(payload, status="success" if changed else "skipped")


def record_adapter_call(
    run: "_ScopeRun",
    *,
    provider: str,
    api_format: str,
    canonical_event_count: int,
) -> None:
    """记录一次真实 LLM driver/provider adapter 调用的脱敏计数。"""
    bucket = _diagnostic_bucket(run, "adapter_calls", {
        "count": 0, "success": 0, "errors": 0, "canonical_render_calls": 0,
        "by_provider": {}, "by_api_format": {},
    })
    bucket["count"] = int(bucket.get("count", 0) or 0) + 1
    if canonical_event_count:
        bucket["canonical_render_calls"] = int(bucket.get("canonical_render_calls", 0) or 0) + 1
    for key, value in (("by_provider", provider or "unknown"), ("by_api_format", api_format or "unknown")):
        counts = bucket.setdefault(key, {})
        counts[value] = int(counts.get(value, 0) or 0) + 1


def record_adapter_result(run: "_ScopeRun", status: str) -> None:
    """记录 adapter 调用的结束状态。"""
    bucket = _diagnostic_bucket(run, "adapter_calls", {
        "count": 0, "success": 0, "errors": 0, "canonical_render_calls": 0,
        "by_provider": {}, "by_api_format": {},
    })
    key = "success" if status == "success" else "errors"
    bucket[key] = int(bucket.get(key, 0) or 0) + 1


def record_tool_schema_error(
    run: "_ScopeRun",
    *,
    tool_name: str,
    schema: Any,
    error: Any,
    error_kind: str,
    arguments_shape: Any = None,
    provider_schema: Any = None,
    parent_span_id: str | None = None,
) -> None:
    """记录一次工具 schema 错误及模型实际看到的声明。

    schema 是工具注册表的权威声明；provider_schema 由调用轮提供时，优先用于
    对照 wire 格式。参数只记录结构，不记录字符串正文或文件名等实际值。
    """
    if not _enabled() or run.ended_at is not None:
        return
    try:
        schema_value = _jsonable(schema if isinstance(schema, dict) else {})
        provider_value = _jsonable(provider_schema) if isinstance(provider_schema, dict) else None
        canonical = provider_value if provider_value is not None else schema_value
        schema_text = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(schema_text.encode("utf-8")).hexdigest()[:16]
        span = run.span(
            "tool",
            f"Tool schema error · {tool_name}",
            {
                "tool_name": tool_name,
                "schema": schema_value,
                "provider_schema": provider_value,
                "schema_digest": digest,
                "arguments_shape": _jsonable(arguments_shape or {}),
                "error": _jsonable(error),
            },
            parent_span_id=parent_span_id,
            context_source="tool_schema_error",
            error_kind=error_kind,
            schema_digest=digest,
        )
        span.finish({
            "tool_name": tool_name,
            "schema_digest": digest,
            "error_kind": error_kind,
        }, status="error")
        issues = error.get("issues") if isinstance(error, dict) else []
        field_paths = sorted({
            str(item.get("path")) for item in issues
            if isinstance(item, dict) and item.get("path")
        })
        provider_name = "unknown"
        adapter_calls = run.attributes.get("adapter_calls")
        if isinstance(adapter_calls, dict):
            providers = adapter_calls.get("by_provider")
            if isinstance(providers, dict) and len(providers) == 1:
                provider_name = str(next(iter(providers)))
        aggregate = _diagnostic_bucket(run, "tool_schema_errors", {
            "count": 0, "by_tool": {}, "by_error_kind": {},
            "by_field_path": {}, "by_provider": {},
        })
        aggregate["count"] = int(aggregate.get("count", 0) or 0) + 1
        for bucket_name, values in (
            ("by_tool", [tool_name]),
            ("by_error_kind", [error_kind]),
            ("by_field_path", field_paths),
            ("by_provider", [provider_name]),
        ):
            counts = aggregate.setdefault(bucket_name, {})
            for value in values:
                counts[value] = int(counts.get(value, 0) or 0) + 1
    except Exception:
        pass

@dataclass
class _Span:
    id: str
    kind: str
    name: str
    started_at: float
    input: Any = field(default_factory=dict)
    attributes: dict[str, Any] = field(default_factory=dict)
    parent_span_id: str | None = None
    code: dict[str, Any] = field(default_factory=dict)
    usage: dict[str, Any] = field(default_factory=dict)
    token_impact: dict[str, Any] = field(default_factory=dict)
    ended_at: float | None = None
    duration_ms: float | None = None
    status: str = "running"
    output: Any = field(default_factory=dict)

    def finish(self, output: Any = None, *, status: str = "success") -> None:
        self.ended_at = _now()
        self.duration_ms = round((self.ended_at - self.started_at) * 1000, 3)
        self.status = status
        if output is not None:
            self.output = _jsonable(output)

    def payload(self) -> dict[str, Any]:
        return _jsonable(vars(self))

@dataclass
class _ScopeRun:
    id: str
    trace_id: str
    session_key: str
    external_session_id: str
    source: str
    started_at: float
    spans: list[_Span] = field(default_factory=list)
    pending_context_spans: list[_Span] = field(default_factory=list)
    input: dict[str, Any] = field(default_factory=dict)
    output_text: str = ""
    attributes: dict[str, Any] = field(default_factory=dict)
    usage: dict[str, Any] = field(default_factory=lambda: {
        "input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
        "fresh_input": 0, "total": 0, "cache_ratio": 0,
    })
    ended_at: float | None = None
    status: str = "running"

    def span(
        self,
        kind: str,
        name: str,
        input: Any = None,
        *,
        parent_span_id: str | None = None,
        code: dict[str, Any] | None = None,
        token_impact: dict[str, Any] | None = None,
        **attrs: Any,
    ) -> _Span:
        s = _Span(
            id=f"{self.id}:s{len(self.spans)+1}",
            kind=kind,
            name=name,
            started_at=_now(),
            input=_jsonable(input if input is not None else {}),
            attributes=_jsonable(attrs),
            parent_span_id=parent_span_id,
            code=_jsonable(code or {}),
            token_impact=_jsonable(token_impact or {}),
        )
        self.spans.append(s)
        return s

    def attach_context_spans(self, parent_span_id: str) -> None:
        for s in self.pending_context_spans:
            s.parent_span_id = parent_span_id
            self.spans.append(s)
        self.pending_context_spans.clear()

    def add_usage(self, usage: dict[str, Any]) -> None:
        for key in ("input", "output", "cache_read", "cache_write", "fresh_input"):
            self.usage[key] = int(self.usage.get(key, 0) or 0) + int(usage.get(key, 0) or 0)
        self.usage["total"] = int(self.usage["input"]) + int(self.usage["output"])
        self.usage["cache_ratio"] = (
            round(int(self.usage["cache_read"]) / int(self.usage["input"]), 6)
            if self.usage["input"] else 0
        )
        # 0.1 UI/历史 DB 的兼容字段继续保留。
        self.attributes["tokens"] = copy.deepcopy(self.usage)

    def snapshot(self) -> dict[str, Any]:
        ended = self.ended_at or _now()
        return {
            "id": self.id,
            "trace_id": self.trace_id,
            "session_key": self.session_key,
            "external_session_id": self.external_session_id,
            "source": self.source,
            "status": self.status,
            "started_at": self.started_at,
            "ended_at": ended,
            "duration_ms": round((ended - self.started_at) * 1000, 3),
            "input": _jsonable(self.input),
            "output": {"text": self.output_text},
            "attributes": _jsonable(self.attributes),
            "usage": _jsonable(self.usage),
            "spans": [s.payload() for s in self.spans],
        }

def record_context_source(
    kind: str,
    name: str,
    *,
    input: Any = None,
    output: Any = None,
    attributes: dict[str, Any] | None = None,
    code_target: Any = None,
    source_value: Any = None,
    included_value: Any = None,
    started_at: float | None = None,
    ended_at: float | None = None,
) -> None:
    """给当前 Run 记录一个 Context Source；调用方可安全地无条件调用。"""
    if not _enabled():
        return
    run = _scope_run.get()
    if run is None or run.ended_at is not None:
        return
    try:
        start = started_at or _now()
        end = ended_at or _now()
        impact: dict[str, Any] = {}
        if source_value is not None:
            impact["source_tokens"] = _estimate_tokens(source_value)
        if included_value is not None:
            impact["included_tokens"] = _estimate_tokens(included_value)
        span = _Span(
            id=f"{run.id}:ctx{len(run.pending_context_spans)+1}",
            kind=kind,
            name=name,
            started_at=start,
            ended_at=end,
            duration_ms=round(max(end - start, 0) * 1000, 3),
            status="success",
            input=_jsonable(input if input is not None else {}),
            output=_jsonable(output if output is not None else {}),
            attributes=_jsonable({"context_source": True, **(attributes or {})}),
            code=_code_ref(code_target) if code_target is not None else _code_ref(frame_depth=2),
            token_impact=impact,
        )
        run.pending_context_spans.append(span)
    except Exception:
        pass


def record_snapshot_event(
    phase: str,
    *,
    context_epoch: int | None,
    snapshot_hash: str | None,
    session_info_hash: str | None,
    expires_at: Any = None,
) -> None:
    """记录脱敏的 session snapshot 生命周期事件。

    只写 hash、epoch 和时间状态，不写 snapshot 正文、用户消息或业务数据。
    没有 active LoopScope run 时静默跳过，避免影响 IM/离线任务主链路。
    """
    if not _enabled():
        return
    run = _scope_run.get()
    if run is None or run.ended_at is not None:
        return
    try:
        event = {
            "schema_version": 1,
            "phase": phase,
            "context_epoch": context_epoch,
            "snapshot_hash": snapshot_hash or "",
            "session_info_hash": session_info_hash or "",
            "expires_at": expires_at.isoformat() if hasattr(expires_at, "isoformat") else None,
        }
        span = _Span(
            id=f"{run.id}:ctx{len(run.pending_context_spans)+1}",
            kind="context",
            name="Session snapshot",
            started_at=_now(),
            ended_at=_now(),
            duration_ms=0,
            status="success",
            input={"snapshot": event},
            output={"snapshot": {"phase": phase, "context_epoch": context_epoch}},
            attributes={"context_source": True, "snapshot_event": True},
            code=_code_ref(frame_depth=2),
        )
        run.pending_context_spans.append(span)
    except Exception:
        pass


def record_context_layout(
    messages: Any,
    *,
    metadata: dict[str, Any] | None = None,
    system_text: str = "",
    parent_span_id: str | None = None,
) -> None:
    """记录 provider loop 实际收到的上下文边界（仅长度/指纹/标记）。"""
    if not _enabled():
        return
    run = _scope_run.get()
    if run is None or run.ended_at is not None:
        return
    try:
        rows = list(messages) if isinstance(messages, (list, tuple)) else []
        def _row(value: Any) -> dict[str, Any]:
            if isinstance(value, dict):
                role = str(value.get("role") or "")
                content = value.get("content")
            else:
                role = str(getattr(value, "role", "") or "")
                content = getattr(value, "content", "")
            text = content if isinstance(content, str) else _jsonable(content)
            text = str(text or "")
            markers = [marker for marker in (
                "[system-reminder]", "[群聊历史消息", "[当前群聊发言人", "[group-rag]",
                "[owner-rag]", "[group-member-rag]", "[knowledge-context]",
                "## 当前群组记忆", "## 当前 IM 身份事实", "## 默认相处姿态", "当前时间：",
            ) if marker in text]
            return {
                "role": role,
                "len": len(text),
                "fp": hashlib.sha1(text.encode("utf-8")).hexdigest()[:12],
                "markers": markers,
            }
        row_meta = [_row(item) for item in rows]
        sequence_fp = hashlib.sha1(
            json.dumps(row_meta, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()[:12]
        payload = {
            "phase": "provider-input",
            "provider_message_count": len(row_meta),
            "provider_sequence_fp": sequence_fp,
            "provider_head": row_meta[:3],
            "provider_tail": row_meta[-3:],
            "system_len": len(system_text or ""),
            "system_fp": hashlib.sha1((system_text or "").encode("utf-8")).hexdigest()[:12],
            "application_boundary": _jsonable(metadata or {}),
        }
        _layout_logger.info("[context-layout] %s", payload)
        run.attributes["context_layout"] = payload
        span = run.span(
            "context",
            "Context layout at provider boundary",
            payload,
            parent_span_id=parent_span_id,
            token_impact={"message_count": len(row_meta)},
            context_source="provider-input",
        )
        span.finish({
            "provider_message_count": len(row_meta),
            "provider_sequence_fp": sequence_fp,
        })
    except Exception:
        pass

async def _post_snapshot(snapshot: dict[str, Any]) -> None:
    base = os.getenv("LOOPSCOPE_ENDPOINT", "http://127.0.0.1:4320").rstrip("/")
    url = base if base.endswith("/api/collector/runs") else f"{base}/api/collector/runs"
    data = json.dumps(snapshot, ensure_ascii=False).encode("utf-8")

    def _send() -> None:
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={"Content-Type": "application/json", "User-Agent": "gugu-loopscope-bridge/0.2"},
        )
        with urllib.request.urlopen(req, timeout=0.8) as resp:
            resp.read(32)

    try:
        await asyncio.to_thread(_send)
    except Exception:
        pass

def _finish_run(run: _ScopeRun, status: str) -> None:
    if run.ended_at is not None:
        return
    run.status = status
    run.ended_at = _now()
    snapshot = copy.deepcopy(run.snapshot())
    try:
        task = asyncio.create_task(_post_snapshot(snapshot))
        _send_tasks.add(task)
        task.add_done_callback(_send_tasks.discard)
    except Exception:
        pass

def _discard_run() -> None:
    """丢弃没有进入 Agent 执行链路的临时 run，不向 Collector 上报。"""
    _scope_run.set(None)

def create_trace() -> str:
    t = uuid.uuid4().hex[:12]
    _trace.set(t)
    if _enabled():
        _scope_run.set(_ScopeRun(
            id=f"run-{t}-{uuid.uuid4().hex[:6]}", trace_id=t,
            session_key=f"pending:{t}", external_session_id="",
            source="unknown", started_at=_now(),
        ))
    return t

def restore_trace(t: str | None) -> str:
    t = (t or "").strip() or uuid.uuid4().hex[:12]
    _trace.set(t)
    # 网关在进程 A 生成 trace id，worker 在进程 B 通过 payload 恢复它。
    # ContextVar 不会跨进程传递，因此不能只恢复字符串；必须同时建立一个待
    # 归属到具体 session 的 ScopeRun，后续 LLM hook 才有对象可以收尾上报。
    if _enabled():
        run = _scope_run.get()
        if run is None or run.ended_at is not None:
            _scope_run.set(_ScopeRun(
                id=f"run-{t}-{uuid.uuid4().hex[:6]}", trace_id=t,
                session_key=f"pending:{t}", external_session_id="",
                source="unknown", started_at=_now(),
            ))
    return t

def get_trace() -> str:
    return _trace.get()
