"""按 pattern 条目水位触发的低频自动维护。

维护只在用户已有一轮活跃对话、且 pattern 达到增长阈值时检查，避免后台扫描沉默用户。
"""
from __future__ import annotations

import asyncio
import time

from agent.memory import store

PATTERN_AUTO_THRESHOLD = 100
PATTERN_AUTO_INCREMENT = 30
PATTERN_AUTO_COOLDOWN = 7 * 24 * 60 * 60

_locks: dict[str, asyncio.Lock] = {}
_pending_users: set[str] = set()
_tasks: set[asyncio.Task] = set()


def _lock_for(user_id) -> asyncio.Lock:
    key = str(user_id)
    lock = _locks.get(key)
    if lock is None:
        lock = _locks[key] = asyncio.Lock()
    return lock


async def _run_review(user_id, settings, count: int) -> bool:
    """执行一次自动维护并记录水位；失败不影响当前对话。"""
    try:
        from scripts.refresh_memory import _review_patterns

        result = await _review_patterns(user_id, settings, dry_run=False, trials=3)
        # 只有模型输出成功解析并完成复核，才推进水位；否则下次活跃对话应继续重试。
        if not isinstance(result, dict) or result.get("error"):
            return False
        await store.write_pattern_maintenance(user_id, {
            "last_review_at": time.time(),
            "reviewed_count": count,
        })
        return True
    except Exception:
        # 维护是后台锦上添花功能，模型或存储失败不能影响回复。
        return False


async def maybe_schedule(user_id, settings) -> bool:
    """按条目数和 7 天冷却判断是否异步启动维护。"""
    patterns = await store.read_pattern_list(user_id)
    count = len(patterns)
    if count < PATTERN_AUTO_THRESHOLD:
        return False

    state = await store.read_pattern_maintenance(user_id)
    now = time.time()
    last_review = float(state.get("last_review_at", 0) or 0)
    reviewed_count = int(state.get("reviewed_count", 0) or 0)
    if now - last_review < PATTERN_AUTO_COOLDOWN:
        return False
    if reviewed_count and count < reviewed_count + PATTERN_AUTO_INCREMENT:
        return False

    key = str(user_id)
    lock = _lock_for(user_id)
    if lock.locked() or key in _pending_users:
        return False
    _pending_users.add(key)

    async def run_locked():
        try:
            async with lock:
                await _run_review(user_id, settings, count)
        finally:
            _pending_users.discard(key)

    task = asyncio.create_task(run_locked(), name=f"pattern-maintenance:{user_id}")
    # 保留引用，避免 fire-and-forget 任务在维护尚未完成时被 GC。
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return True
