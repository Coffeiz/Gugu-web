"""Agent full-chain trace id plus optional LoopScope developer instrumentation."""
from __future__ import annotations

from .loopscope_trace.hooks import ensure_hooks
from .loopscope_trace.state import (
    _enabled,
    _finish_run,
    _scope_run,
    create_trace,
    get_trace,
    record_context_source,
    record_snapshot_event,
    restore_trace,
)

def new_trace() -> str:
    t = create_trace()
    if _enabled():
        ensure_hooks()
    return t

def set_trace(t: str | None) -> str:
    t = restore_trace(t)
    if _enabled():
        ensure_hooks()
    return t


def bind_im_run(session_id: int | str | None, source: str) -> None:
    """把已恢复的跨进程 run 绑定到 IM session，供无 LLM 提前返回路径收尾。"""
    if not _enabled() or session_id is None:
        return
    run = _scope_run.get()
    if run is None or run.ended_at is not None:
        return
    run.source = str(source)
    run.session_key = f"gugu:{source}:{session_id}"
    run.external_session_id = str(session_id)


def finish_run(status: str = "success", output_text: str = "") -> None:
    """收尾非 Web 的 Agent run（IM/定时任务），并异步提交 LoopScope。"""
    if not _enabled():
        return
    run = _scope_run.get()
    if run is None or run.ended_at is not None:
        return
    if output_text:
        run.output_text = output_text
    _finish_run(run, status)

__all__ = [
    "new_trace", "set_trace", "bind_im_run", "finish_run", "get_trace",
    "record_context_source", "record_snapshot_event",
]
