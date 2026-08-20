"""Agent full-chain trace id plus optional LoopScope developer instrumentation."""
from __future__ import annotations

from .loopscope_trace.hooks import ensure_hooks
from .loopscope_trace.state import (
    _enabled,
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

__all__ = ["new_trace", "set_trace", "get_trace", "record_context_source", "record_snapshot_event"]
