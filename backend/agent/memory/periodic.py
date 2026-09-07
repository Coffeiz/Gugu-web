"""按 profile/pattern 条目水位触发的低频自动维护。

维护只在用户已有一轮活跃对话、且 profile/pattern 达到增长阈值时检查，避免后台扫描沉默用户。
"""
from __future__ import annotations

import asyncio
import time

from agent.memory import longterm_compaction, store

PATTERN_AUTO_THRESHOLD = 100
PATTERN_AUTO_INCREMENT = 30
PROFILE_AUTO_THRESHOLD = 100
PROFILE_AUTO_INCREMENT = 30
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


async def _run_pattern_compact(user_id, settings, count: int) -> bool:
    """执行一次 pattern 整理并记录水位；失败不影响当前对话。"""
    try:
        if not await longterm_compaction.compact_pattern(user_id, settings):
            return False
        compacted_count = len(await store.read_pattern_list(user_id))
        await store.write_pattern_maintenance(user_id, {
            "last_review_at": time.time(),
            "reviewed_count": compacted_count,
        })
        return True
    except Exception:
        # 维护是后台锦上添花功能，模型或存储失败不能影响回复。
        return False


async def _run_profile_compact(user_id, settings, count: int) -> bool:
    """整理 profile 并记录独立水位；失败时保留原档案。"""
    try:
        if not await longterm_compaction.compact_profile(user_id, settings):
            return False
        compacted_count = len(await store.read_profile_list(user_id))
        state = await store.read_pattern_maintenance(user_id)
        state.update({"profile_last_compact_at": time.time(), "profile_compacted_count": compacted_count})
        await store.write_pattern_maintenance(user_id, state)
        return True
    except Exception:
        return False


async def maybe_schedule(user_id, settings) -> bool:
    """按条目数和 7 天冷却判断是否异步启动维护。"""
    patterns = await store.read_pattern_list(user_id)
    profile = await store.read_profile_list(user_id)
    pattern_count = len(patterns)
    profile_count = len(profile)
    state = await store.read_pattern_maintenance(user_id)
    now = time.time()
    last_review = float(state.get("last_review_at", 0) or 0)
    reviewed_count = int(state.get("reviewed_count", 0) or 0)
    pattern_due = (
        pattern_count >= PATTERN_AUTO_THRESHOLD
        and now - last_review >= PATTERN_AUTO_COOLDOWN
        and (not reviewed_count or pattern_count >= reviewed_count + PATTERN_AUTO_INCREMENT)
    )
    profile_last = float(state.get("profile_last_compact_at", 0) or 0)
    profile_reviewed_count = int(state.get("profile_compacted_count", 0) or 0)
    profile_due = (
        profile_count >= PROFILE_AUTO_THRESHOLD
        and now - profile_last >= PATTERN_AUTO_COOLDOWN
        and (
            not profile_reviewed_count
            or profile_count >= profile_reviewed_count + PROFILE_AUTO_INCREMENT
        )
    )
    if not pattern_due and not profile_due:
        return False

    key = str(user_id)
    lock = _lock_for(user_id)
    if lock.locked() or key in _pending_users:
        return False
    _pending_users.add(key)

    async def run_locked():
        try:
            async with lock:
                if pattern_due:
                    await _run_pattern_compact(user_id, settings, pattern_count)
                if profile_due:
                    await _run_profile_compact(user_id, settings, profile_count)
        finally:
            _pending_users.discard(key)

    task = asyncio.create_task(run_locked(), name=f"memory-maintenance:{user_id}")
    # 保留引用，避免 fire-and-forget 任务在维护尚未完成时被 GC。
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return True
