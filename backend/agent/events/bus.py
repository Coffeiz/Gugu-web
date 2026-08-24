"""轻量异步事件总线：按事件类型订阅，publish 对每个 listener fire-and-forget。

设计：发布方不阻塞、不关心有没有 / 有几个消费者；listener 失败被吞（只记日志），绝不影响主流程。
当前内置 listener：记忆变更落 `agent.events` 日志（可审计）。需要新行为时 `subscribe(类型, 协程)` 即可。
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Awaitable, Callable

from agent.events.types import Event, MemoryUpdated, RagIndexUpdated

_log = logging.getLogger("agent.events")
_listeners: dict[type, list[Callable[[Event], Awaitable]]] = defaultdict(list)
_tasks: set = set()   # 持后台任务引用防 GC


def subscribe(event_type: type, listener: Callable[[Event], Awaitable]) -> None:
    _listeners[event_type].append(listener)


def publish(event: Event) -> None:
    """对该事件类型的所有 listener 各起一个后台任务。需在事件循环内调用（咕咕全程异步）。
    无 listener → 无操作；永不抛、不阻塞。"""
    for listener in _listeners.get(type(event), ()):
        try:
            t = asyncio.create_task(_safe(listener, event))
            _tasks.add(t)
            t.add_done_callback(_tasks.discard)
        except RuntimeError:
            pass   # 无运行中的事件循环（理论上不会）：放弃这次投递，不影响主流程


async def _safe(listener: Callable, event: Event) -> None:
    try:
        await listener(event)
    except Exception:
        _log.warning("event listener %r failed for %s", getattr(listener, "__name__", listener),
                     type(event).__name__, exc_info=True)


# ── 内置 listener：记忆变更审计日志 ──
async def _log_memory_updated(e: MemoryUpdated) -> None:
    # 记忆是 session snapshot 的一部分；变更后让下一个 run 重新读取，而不是
    # 继续命中旧快照。事件总线本身仍保持 best-effort，不阻塞记忆写入。
    from app.core import events as context_events
    await context_events.bump_context_revision(e.user_id, "memory")
    publish(RagIndexUpdated(
        user_id=e.user_id, source_type="memory", source_id="memory", operation="upsert",
    ))
    _log.info("memory.updated user=%s +%d -%d src=%s",
              str(e.user_id)[:8], e.added, e.removed, e.source)


async def _log_rag_index_updated(e: RagIndexUpdated) -> None:
    from agent.rag.index_cache import invalidate_index_cache
    await invalidate_index_cache(e.user_id, e.source_type)
    if e.source_type == "memory":
        from agent.rag.pipeline import handle_memory_index_event
        await handle_memory_index_event(e)
    _log.info("rag.index.%s user=%s source=%s", e.operation, str(e.user_id)[:8], e.source_type)


subscribe(MemoryUpdated, _log_memory_updated)
subscribe(RagIndexUpdated, _log_rag_index_updated)
