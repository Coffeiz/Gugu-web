"""视频转码缓存清理（PRD-STORAGE-1 Phase B）：租约驱动的清理策略，跟 Phase A
的草稿 GC / 安全网扫描是三种不同的生命周期策略（状态驱动 / 消息生命周期驱动 /
租约驱动），独立组织实现——不塞进 `app/core/attachment_gc.py` 那个按状态判断
的扫描逻辑，只共享底层 `list_keys`/`stat`/`delete`/分布式锁这类基础设施。

判断依据是 `chat_attach._video_cache_alive_key()` 这个 Redis "存活标记"：命中
时由 `_video_cache_try_read()` 用 `SET ... EX` 续期（不是 `EXPIRE`——Redis 整体
丢失后 marker 不存在，`EXPIRE` 对不存在的 key 是空操作，续不上）。marker 还在
就跳过；marker 不在（自然过期，或 Redis 丢失过）就按物理年龄清理——物理年龄
留一个短安全窗口，避免误删"文件刚写完、marker 还没来得及 SET 成功"这个毫秒级
竞态窗口（跟 Phase A 安全网对未引用孤儿的处理是同一个思路，只是这里窗口小得多，
因为写文件和写 marker 在 `_compress_video_cached()` 里是同一次调用紧挨着做的）。
"""
from __future__ import annotations

from app.core import redis as R
from app.core import scheduler
from app.core.tz import now_utc

_LOCK_KEY = "storage:video_cache_gc:lock"
_LOCK_TIMEOUT = 1800
_MIN_AGE_WITHOUT_MARKER = 3600   # marker 不在时，物理年龄至少要超过这个才清理


def _parse_video_cache_path(key: str) -> tuple[str | None, str | None]:
    """`{user_id}/.video_cache/{cache_key}.mp4` → (user_id, cache_key)；
    不是这个前缀/格式不对就返回 (None, None)，调用方据此跳过。"""
    parts = key.split("/")
    if len(parts) != 3 or parts[1] != ".video_cache":
        return None, None
    user_id = parts[0]
    filename = parts[2]
    cache_key = filename.rsplit(".", 1)[0] if "." in filename else filename
    if not user_id or not cache_key:
        return None, None
    return user_id, cache_key


async def _sweep_locked() -> int:
    from app.core import chat_attach
    from app.services.storage import get_storage
    storage = get_storage()
    redis = R.get_redis()
    now_ts = now_utc().timestamp()
    deleted = 0
    remaining_count = 0
    remaining_bytes = 0
    for key in await storage.list_keys():
        user_id, cache_key = _parse_video_cache_path(key)
        if not user_id or not cache_key:
            continue
        alive_key = chat_attach._video_cache_alive_key(user_id, cache_key)
        try:
            marker = await redis.get(alive_key)
        except Exception:
            # Redis 不可用时保守跳过删除判断（不误删），但仍计入快照统计——
            # 这个对象客观上还占着空间，快照要如实反映当前占用，不能因为
            # Redis 暂时连不上就在图表上凭空"消失"一块。
            info = await storage.stat(key)
            if info is not None:
                remaining_count += 1
                remaining_bytes += info.size
            continue
        if marker:
            info = await storage.stat(key)
            if info is not None:
                remaining_count += 1
                remaining_bytes += info.size
            continue
        info = await storage.stat(key)
        if info is None or info.mtime is None:
            continue
        if now_ts - info.mtime < _MIN_AGE_WITHOUT_MARKER:
            remaining_count += 1
            remaining_bytes += info.size
            continue
        try:
            await storage.delete(key)
            deleted += 1
        except Exception:
            remaining_count += 1
            remaining_bytes += info.size
    from app.core import storage_snapshots
    await storage_snapshots.record_snapshot(
        storage_snapshots.CATEGORY_VIDEO_CACHE, remaining_count, remaining_bytes)
    return deleted


async def sweep_video_cache() -> int:
    """视频转码缓存清理入口。返回真正删除的缓存对象数。"""
    lock = R.get_redis().lock(_LOCK_KEY, timeout=_LOCK_TIMEOUT, blocking=False)
    if not await lock.acquire(blocking=False):
        return 0
    try:
        return await _sweep_locked()
    finally:
        try:
            await lock.release()
        except Exception:
            pass


@scheduler.register(scheduler.cron(hour=5, minute=0), id="video_cache_gc", name="视频转码缓存清理")
async def _run_video_cache_gc() -> None:
    """跟 Phase A 的两个 job（4:00/4:30）错开，避免同时段抢 I/O。"""
    try:
        n = await sweep_video_cache()
        if n:
            print(f"[video_cache_gc] 清理了 {n} 个视频缓存对象", flush=True)
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("app.core.video_cache_gc.sweep", exc)
