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

# 同一用户、同一来源只允许一个索引重建 worker。重建函数读取的是当前主数据，
# 因此连续的 upsert/delete 只需保留最后一个事件；若事件在重建期间到达，worker
# 会在本次完成后再跑一遍，避免“合并事件”变成丢更新。
_rag_workers: dict[tuple[str, str], asyncio.Task] = {}
_rag_pending: dict[tuple[str, str], RagIndexUpdated] = {}
_rag_status: dict[tuple[str, str], dict[str, object]] = {}


def subscribe(event_type: type, listener: Callable[[Event], Awaitable]) -> None:
    _listeners[event_type].append(listener)


def publish(event: Event) -> None:
    """对该事件类型的所有 listener 各起一个后台任务。需在事件循环内调用（咕咕全程异步）。
    无 listener → 无操作；永不抛、不阻塞。"""
    for listener in _listeners.get(type(event), ()):
        try:
            if type(event) is RagIndexUpdated and listener is _log_rag_index_updated:
                _enqueue_rag_index_event(event)
                continue
            t = asyncio.create_task(_safe(listener, event))
            _tasks.add(t)
            t.add_done_callback(_tasks.discard)
        except RuntimeError:
            pass   # 无运行中的事件循环（理论上不会）：放弃这次投递，不影响主流程


def _rag_event_key(event: RagIndexUpdated) -> tuple[str, str]:
    return str(event.user_id), str(event.source_type)


def _enqueue_rag_index_event(event: RagIndexUpdated) -> None:
    """合并同源事件并启动唯一的来源级 drain worker。"""
    key = _rag_event_key(event)
    _rag_pending[key] = event
    status = _rag_status.setdefault(key, {
        "state": "idle", "generation": 0, "completed_generation": 0,
        "pending": False,
    })
    status["generation"] = int(status["generation"]) + 1
    status["pending"] = True
    if status["state"] != "running":
        status["state"] = "queued"
    worker = _rag_workers.get(key)
    if worker is None or worker.done():
        try:
            worker = asyncio.create_task(_drain_rag_index_events(key))
        except RuntimeError:
            # 和普通 listener 一样，无事件循环时不影响主写入；事件无法排队。
            status["state"] = "failed"
            status["pending"] = False
            status["last_error"] = "no_event_loop"
            return
        _rag_workers[key] = worker
        _tasks.add(worker)
        worker.add_done_callback(_tasks.discard)


def get_rag_index_status(user_id: object, source_type: str) -> dict[str, object]:
    """返回不含正文、路径和异常详情的来源索引状态。"""
    key = str(user_id), str(source_type)
    status = _rag_status.get(key)
    if status is None:
        return {"state": "idle", "generation": 0, "completed_generation": 0, "pending": False}
    return dict(status)


async def _drain_rag_index_events(key: tuple[str, str]) -> None:
    """串行消费一个来源的最新事件；失败不阻塞业务写入。"""
    current = asyncio.current_task()
    try:
        while True:
            event = _rag_pending.pop(key, None)
            if event is None:
                status = _rag_status.get(key)
                if status is not None:
                    status["state"] = "ready"
                    status["pending"] = False
                return
            status = _rag_status.setdefault(key, {
                "state": "queued", "generation": 0, "completed_generation": 0,
                "pending": True,
            })
            generation = int(status["generation"])
            status["state"] = "running"
            status["pending"] = bool(key in _rag_pending)
            try:
                success = bool(await _log_rag_index_updated(event))
            except Exception:
                # 异常详情可能包含宿主路径或用户数据；可见日志只保留固定分类。
                _log.warning("rag index worker failed for source=%s", key[1])
                success = False
            status = _rag_status.get(key)
            if status is None:
                continue
            if success:
                status["completed_generation"] = generation
                status.pop("last_error", None)
                status["state"] = "ready" if key not in _rag_pending else "queued"
            else:
                status["last_error"] = "index_update_failed"
                status["state"] = "failed" if key not in _rag_pending else "queued"
            status["pending"] = bool(key in _rag_pending)
    finally:
        if _rag_workers.get(key) is current:
            _rag_workers.pop(key, None)


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


async def _log_rag_index_updated(e: RagIndexUpdated) -> bool:
    from agent.rag.index_cache import invalidate_index_cache
    await invalidate_index_cache(e.user_id, e.source_type)
    if e.source_type == "memory":
        from agent.rag.adapters.memory import MemoryAdapter
        MemoryAdapter.invalidate_scope_cache(e.user_id)
        from agent.rag.pipeline import handle_memory_index_event
        success = await handle_memory_index_event(e)
    else:
        from agent.rag.pipeline import handle_rag_index_event
        success = await handle_rag_index_event(e)
    _log.info("rag.index.%s user=%s source=%s success=%s",
              e.operation, str(e.user_id)[:8], e.source_type, bool(success))
    return bool(success)


subscribe(MemoryUpdated, _log_memory_updated)
subscribe(RagIndexUpdated, _log_rag_index_updated)
