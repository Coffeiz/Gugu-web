"""统一的存储用量快照记录（PRD-STORAGE-2 存储监控面板）。

不同类别的用量来源不同——有的能直接用 DB 汇总列算（零扫描成本：`files`/
`chat_attachments` 都已经有 `size`/`size_bytes` 列），有的得靠扫存储的定时
任务（视频转码缓存，见 `app/core/video_cache_gc.py`）——但落地的地方是同一张
`storage_category_snapshots` 表、同一个 `record_snapshot()` 入口，管理后台
按 `category` 分组查询画趋势图，不需要为每个类别各建一张表、各查一次。
"""
from __future__ import annotations

from app.core import redis as R
from app.core import scheduler

CATEGORY_VIDEO_CACHE = "video_cache"
CATEGORY_CHAT_DRAFT = "chat_staging_draft"
CATEGORY_CHAT_ATTACHED = "chat_staging_attached"
CATEGORY_USER_FILES = "user_files"

_LOCK_KEY = "storage:usage_snapshot:lock"
_LOCK_TIMEOUT = 600


async def record_snapshot(category: str, object_count: int, total_bytes: int) -> None:
    """落一条快照；失败只记日志，不影响调用方本身的清理/统计流程（比如
    `video_cache_gc` 的清理结果不应该因为快照写入失败就跟着报错）。"""
    try:
        from app.models import StorageCategorySnapshot
        import app.db.session as db_session
        db_session.ensure_engine()
        async with db_session._SessionLocal() as db:
            db.add(StorageCategorySnapshot(category=category, object_count=object_count, total_bytes=total_bytes))
            await db.commit()
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log(f"app.core.storage_snapshots.record_snapshot.{category}", exc)


async def compute_sql_totals() -> dict[str, dict[str, int]]:
    """能直接用 DB 汇总列算的几类——不碰存储层，一条 SQL 秒出结果，**可以
    随时实时查，不需要等定时任务落过快照**：聊天附件按 `draft`/`attached`
    分开统计（能直接反映草稿清理任务是否在正常工作：如果草稿占用只涨不跌，
    大概率是清理任务挂了），加上用户文件库总量。

    这个函数是"当前时刻的真实数字"，`record_sql_snapshots()`（定时任务）只是
    在这基础上多做一步"把这次算出来的数字存进历史快照表"，两者共用同一份
    计算逻辑，不是两套口径。"""
    from sqlalchemy import func, select
    from app.models import ChatAttachment, File
    import app.db.session as db_session
    db_session.ensure_engine()
    result: dict[str, dict[str, int]] = {}
    async with db_session._SessionLocal() as db:
        for state, category in (("draft", CATEGORY_CHAT_DRAFT), ("attached", CATEGORY_CHAT_ATTACHED)):
            row = (await db.execute(
                select(func.count(ChatAttachment.id), func.coalesce(func.sum(ChatAttachment.size), 0))
                .where(ChatAttachment.state == state)
            )).one()
            result[category] = {"object_count": int(row[0] or 0), "total_bytes": int(row[1] or 0)}

        row = (await db.execute(
            select(func.count(File.id), func.coalesce(func.sum(File.size_bytes), 0))
        )).one()
        result[CATEGORY_USER_FILES] = {"object_count": int(row[0] or 0), "total_bytes": int(row[1] or 0)}
    return result


async def record_sql_snapshots() -> None:
    """定时任务入口：算一遍 `compute_sql_totals()`，把结果落进历史快照表
    （画趋势图用）。Redis 锁防止 backend/worker 并发触发同一次统计。"""
    lock = R.get_redis().lock(_LOCK_KEY, timeout=_LOCK_TIMEOUT, blocking=False)
    if not await lock.acquire(blocking=False):
        return
    try:
        totals = await compute_sql_totals()
        for category, values in totals.items():
            await record_snapshot(category, values["object_count"], values["total_bytes"])
    finally:
        try:
            await lock.release()
        except Exception:
            pass


@scheduler.register(scheduler.cron(hour=1, minute=15), id="storage_usage_snapshot", name="存储用量快照（SQL 汇总类）")
async def _run_storage_usage_snapshot() -> None:
    """所有存储相关定时任务统一从 0 点起跑：0:00 草稿 GC → 0:30 安全网 →
    1:00 video_cache_gc → 1:15 这里。"""
    try:
        await record_sql_snapshots()
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("app.core.storage_snapshots.sql_snapshots", exc)
