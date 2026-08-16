"""全链路 trace_id + 可选 LoopScope 开发期观测桥。

原有职责仍是为一条消息生成/恢复唯一 trace_id。LoopScope hook 只有在
`LOOPSCOPE_ENABLED=true` 时才安装，并且所有采集/发送都是 best-effort：
Scope 不可达、序列化失败或 hook 本身异常都不能改变 AgentLoop 行为。

0.1 为了把接入面压到最小，hook 利用三个已经稳定的统一边界：
- genstream.begin/publish：绑定 Web session、捕获最终用户可见输出；
- LLMRunner._run_loop + driver.run_round：捕获完整 prompt/messages 和每轮候选输出；
- registry.dispatch：捕获统一工具入参/返回。

注意：`draft` 是应用已经拿到的模型候选文本，不是模型私有隐藏思维链。
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import time
import urllib.request
import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

_trace: ContextVar[str] = ContextVar("trace_id", default="")
_scope_run: ContextVar["_ScopeRun | None"] = ContextVar("loopscope_run", default=None)
_hooks_installed = False
_send_tasks: set[asyncio.Task] = set()


def _enabled() -> bool:
    return os.getenv("LOOPSCOPE_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}


def _now() -> float:
    return time.time()


def _jsonable(value: Any, depth: int = 0) -> Any:
    """把 provider/tool 对象安全变成 JSON；观测失败时宁可 repr，也不影响主链路。"""
    if depth > 8:
        return "<max-depth>"
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v, depth + 1) for v in value]
    if hasattr(value, "model_dump"):
        try:
            return _jsonable(value.model_dump(), depth + 1)
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        try:
            public = {k: v for k, v in vars(value).items() if not k.startswith("_")}
            return _jsonable(public, depth + 1)
        except Exception:
            pass
    try:
        return repr(value)[:5000]
    except Exception:
        return f"<{type(value).__name__}>"


@dataclass
class _Span:
    id: str
    kind: str
    name: str
    started_at: float
    input: Any = field(default_factory=dict)
    attributes: dict[str, Any] = field(default_factory=dict)
    parent_span_id: str | None = None
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
    input: dict[str, Any] = field(default_factory=dict)
    output_text: str = ""
    attributes: dict[str, Any] = field(default_factory=dict)
    ended_at: float | None = None
    status: str = "running"

    def span(self, kind: str, name: str, input: Any = None, **attrs: Any) -> _Span:
        s = _Span(
            id=f"{self.id}:s{len(self.spans)+1}",
            kind=kind,
            name=name,
            started_at=_now(),
            input=_jsonable(input if input is not None else {}),
            attributes=_jsonable(attrs),
        )
        self.spans.append(s)
        return s

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
            "spans": [s.payload() for s in self.spans],
        }


def _extract_last_user(messages: Any) -> str:
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            bits = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    bits.append(str(block.get("text") or ""))
            return "\n".join(bits)
    return ""


def _round_result(result: Any) -> dict[str, Any]:
    if result is None:
        return {}
    calls = []
    for tc in getattr(result, "tool_calls", None) or []:
        calls.append({
            "name": getattr(tc, "name", ""),
            "input": _jsonable(getattr(tc, "input", {})),
            "parse_error": bool(getattr(tc, "parse_error", False)),
        })
    return {
        "draft": getattr(result, "text", "") or "",
        "tool_calls": calls,
        "usage": {
            "input": getattr(result, "usage_in", 0),
            "output": getattr(result, "usage_out", 0),
            "cache_read": getattr(result, "cache_tokens", 0),
        },
    }


def _classify_followup(text: str) -> str:
    if "内部核验" in text or "需要查询" in text:
        return "verification"
    if "工具" in text and ("调用" in text or "执行" in text):
        return "tool-use guard"
    if "意图" in text or "当场" in text:
        return "intent guard"
    if "用户" in text and ("明确" in text or "要求" in text):
        return "decision guard"
    return "follow-up guard"


async def _post_snapshot(snapshot: dict[str, Any]) -> None:
    base = os.getenv("LOOPSCOPE_ENDPOINT", "http://127.0.0.1:4320").rstrip("/")
    url = base if base.endswith("/api/collector/runs") else f"{base}/api/collector/runs"
    data = json.dumps(snapshot, ensure_ascii=False).encode("utf-8")

    def _send() -> None:
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={"Content-Type": "application/json", "User-Agent": "gugu-loopscope-bridge/0.1"},
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


def _ensure_loopscope_hooks() -> None:
    global _hooks_installed
    if _hooks_installed or not _enabled():
        return

    try:
        from agent.llm import genstream
        from agent.core import LLMRunner
        from agent.tools import registry
    except Exception:
        return

    original_begin = genstream.begin
    original_publish = genstream.publish
    original_run_loop = LLMRunner._run_loop
    original_dispatch = registry.dispatch

    async def begin(session_id):
        result = await original_begin(session_id)
        try:
            trace_id = get_trace() or uuid.uuid4().hex[:12]
            run = _scope_run.get()
            if run is None or run.ended_at is not None:
                run = _ScopeRun(
                    id=f"run-{trace_id}-{uuid.uuid4().hex[:6]}",
                    trace_id=trace_id,
                    session_key=f"gugu:web:{session_id}",
                    external_session_id=str(session_id),
                    source="web",
                    started_at=_now(),
                )
            else:
                # Web 入口在拿到 session id 前就已 new_trace；这里把 pending Run 绑定到真实会话，
                # 从而 Run 总耗时包含前置 DB/context/history 准备，而不是只从第一次 LLM 开始计。
                run.trace_id = trace_id
                run.session_key = f"gugu:web:{session_id}"
                run.external_session_id = str(session_id)
                run.source = "web"
            _scope_run.set(run)
        except Exception:
            pass
        return result

    async def publish(session_id, event):
        result = await original_publish(session_id, event)
        try:
            run = _scope_run.get()
            if run is not None and str(session_id) == run.external_session_id and isinstance(event, dict):
                etype = event.get("type")
                if etype == "token":
                    run.output_text += str(event.get("content") or "")
                elif etype == "done":
                    out = run.span("output", "Final response", {"source": "genstream.publish"})
                    out.finish({"text": run.output_text})
                    _finish_run(run, "success")
                elif etype == "error":
                    err = run.span("output", "Agent error", {})
                    err.finish(event, status="error")
                    _finish_run(run, "error")
        except Exception:
            pass
        return result

    async def dispatch(user_id, name, args):
        run = _scope_run.get()
        span = run.span("tool", str(name), {"arguments": _jsonable(args)}) if run else None
        try:
            result = await original_dispatch(user_id, name, args)
            if span:
                tool_result, artifact = result
                span.finish({"result": _jsonable(tool_result), "artifact": _jsonable(artifact)})
            return result
        except BaseException as exc:
            if span:
                span.finish({"error_type": type(exc).__name__}, status="error")
            raise

    async def run_loop(self, driver, user_id, messages, ai, system_text):
        run = _scope_run.get()
        original_round = getattr(driver, "run_round")
        round_index = 0

        initial_user = _extract_last_user(messages)
        if run:
            run.input = {
                "user_message": initial_user,
                "user_id": str(user_id),
            }
            run.attributes.update({
                "provider": getattr(ai, "provider", ""),
                "model": getattr(ai, "model", ""),
                "api_format": getattr(driver, "api_format", ""),
            })
            ctx_span = run.span(
                "context",
                "Context assembly & prompt",
                {
                    "system_prompt": system_text,
                    "messages": _jsonable(messages),
                },
                note="Full application-visible prompt/messages at loop entry",
            )
            # Pending Run 在 web.stream() 的 trace.new_trace() 时就建立；把 context span 的
            # 起点回拨到 Run 起点，使它覆盖项目/事件/history/memory/prompt 的前置准备时间。
            ctx_span.started_at = run.started_at
            ctx_span.finish({
                "system_prompt": system_text,
                "message_count": len(messages) if isinstance(messages, list) else None,
            })

        async def traced_round(client, ctx, round_messages):
            nonlocal round_index
            round_index += 1
            span = run.span(
                "llm",
                f"LLM round {round_index}",
                {
                    "system_prompt": system_text if round_index == 1 else None,
                    "messages": _jsonable(round_messages),
                },
                round=round_index,
                provider=getattr(ai, "provider", ""),
                model=getattr(ai, "model", ""),
            ) if run else None
            final = None
            try:
                async for kind, value in original_round(client, ctx, round_messages):
                    if kind == "done":
                        final = value
                    yield kind, value
                if span:
                    details = _round_result(final)
                    span.finish(details)
                    usage = details.get("usage") or {}
                    totals = run.attributes.setdefault("tokens", {"input": 0, "output": 0, "cache_read": 0})
                    for key in ("input", "output", "cache_read"):
                        totals[key] = int(totals.get(key, 0) or 0) + int(usage.get(key, 0) or 0)
            except BaseException as exc:
                if span:
                    span.finish({"error_type": type(exc).__name__}, status="error")
                raise

        try:
            driver.run_round = traced_round
            async for line in original_run_loop(self, driver, user_id, messages, ai, system_text):
                yield line
                if run and isinstance(line, str) and '"_new_round"' in line:
                    prompt = _extract_last_user(messages)
                    if prompt and prompt != initial_user:
                        transition = run.span("guard", _classify_followup(prompt), {"followup_prompt": prompt})
                    else:
                        transition = run.span("state", "Continue after tool round", {"round": round_index})
                    transition.finish({"next_round": round_index + 1})
        finally:
            try:
                driver.run_round = original_round
            except Exception:
                pass

    genstream.begin = begin
    genstream.publish = publish
    registry.dispatch = dispatch
    LLMRunner._run_loop = run_loop
    _hooks_installed = True


def new_trace() -> str:
    """生成新 trace_id 并设为当前上下文（入口用：网关收消息 / web stream 开始）。"""
    t = uuid.uuid4().hex[:12]
    _trace.set(t)
    if _enabled():
        # 先建 pending Run，再让 web 侧 genstream.begin(session_id) 绑定真实会话。这样
        # 前置 context/history 准备也处于同一个 Run 时间范围内。IM 路若没有 begin，
        # pending Run 不会发送；不会改变现有 IM 行为。
        _scope_run.set(_ScopeRun(
            id=f"run-{t}-{uuid.uuid4().hex[:6]}",
            trace_id=t,
            session_key=f"pending:{t}",
            external_session_id="",
            source="unknown",
            started_at=_now(),
        ))
        _ensure_loopscope_hooks()
    return t


def set_trace(t: str | None) -> str:
    """恢复上游 trace_id（worker 消费队列时用）；空则新生成。"""
    t = (t or "").strip() or uuid.uuid4().hex[:12]
    _trace.set(t)
    if _enabled():
        _ensure_loopscope_hooks()
    return t


def get_trace() -> str:
    """当前上下文 trace_id；未设置返回空串。"""
    return _trace.get()
