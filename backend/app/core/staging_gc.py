"""暂存附件（`.chat_staging/`/`.voice/`）孤儿清理：按物理年龄定时扫存储删除。

`chat_attach.stage()` 把附件字节永久写入存储，TTL 只挂在 Redis 元数据上
（`ex=ttl`）——Redis key 过期只是那条记录消失，从不触发任何回调去删除对应的
存储对象；`save_uploaded_file` 把暂存附件存进文件库时也是复制一份，从未删除
`.chat_staging/` 里的原始副本。两种情况都会让存储字节永久变成孤儿。Redis 数据
整体丢失（容器重建、没挂持久化卷）时，这个泄漏会瞬间大批发生，不只是自然
7 天过期这一种触发方式（见 PRD-STORAGE-1 第 1 节）。

这里**不读 Redis、不依赖"这个附件是否还被引用"的状态判断**，纯粹按物理写入
时间（`stat().mtime`）算年龄——同一套逻辑天然覆盖"自然过期没人清"和"Redis
数据丢失"两种触发方式，不需要区分场景，也不会因为用户读取过附件而续命
（`mtime` 只在写入时打上，`get()` 不会更新它，跟现有 Redis TTL 语义一致，延续
"暂存 N 天，过期清"的既有产品语义，不是行为变化）。
"""
from __future__ import annotations

from app.core import redis as R
from app.core import scheduler
from app.core.tz import now_utc

_LOCK_KEY = "storage:staging_gc:lock"
_LOCK_TIMEOUT = 1800   # 预估最长运行时间的上限：超过这个时间锁自动释放，防止进程崩溃后死锁


def _staging_ttl(key: str) -> int | None:
    """按路径判断该用哪个 TTL；不是 `.chat_staging/`/`.voice/` 下的对象返回 None（不清）。

    `.voice/` 判断放前面：语音条的 key 形如 `{uid}/.voice/{attach_id}.{ext}`，
    不会同时匹配 `.chat_staging/`，顺序本身不影响正确性，只是让分支意图更直白。
    """
    from app.core import chat_attach
    if "/.voice/" in key:
        return chat_attach.TTL_VOICE
    if "/.chat_staging/" in key:
        return chat_attach.TTL
    return None


async def _sweep_locked() -> int:
    from app.services.storage import get_storage
    storage = get_storage()
    now = now_utc().timestamp()
    deleted = 0
    for key in await storage.list_keys():
        ttl = _staging_ttl(key)
        if ttl is None:
            continue
        info = await storage.stat(key)
        if info is None or info.mtime is None:
            continue   # 拿不到 mtime（对象已被删/OSS 极端情况）→ 保守不删
        if now - info.mtime > ttl:
            await storage.delete(key)
            deleted += 1
    return deleted


async def sweep_expired_staging() -> int:
    """扫全存储，删除 `.chat_staging/`/`.voice/` 下物理 mtime 超过对应 TTL 的对象。

    返回删除数量。用 Redis 锁防止 backend/worker（或未来多 worker）同时触发一次
    全量扫描；抢不到锁直接返回 0，不是错误——同一时刻只需要一个进程真正执行。
    """
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


@scheduler.register(scheduler.cron(hour=4, minute=0), id="staging_gc", name="暂存附件孤儿清理")
async def _run_staging_gc() -> None:
    """凌晨低峰跑，避开白天的存储 I/O 高峰。"""
    try:
        n = await sweep_expired_staging()
        if n:
            print(f"[staging_gc] 清理了 {n} 个过期暂存对象", flush=True)
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("app.core.staging_gc.sweep", exc)
