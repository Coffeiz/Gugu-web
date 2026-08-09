"""运维指标端点（商用就绪评审 P0-4「从日志到看板」）。

数据来自 app/core/opsmetrics.py 的 Redis 按日聚合（dispatch 工具漏斗旁路累计）。
与 /admin/analytics（产品指标：日活/留存/漏斗）分开——这里是可靠性口径：
工具失败率、延迟分布、P99 近似。挂 require_admin（main.py include 时注入）。
"""
from datetime import timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import opsmetrics
from app.core.tz import now_utc, iso_utc
from app.db.session import get_db

router = APIRouter(prefix="/admin/ops", tags=["admin"])


@router.get("/summary")
async def ops_summary(days: int = Query(1, ge=1, le=14)):
    """近 N 天（默认今天）工具调用运维汇总：每工具调用量/失败数/失败率/平均耗时，
    全局失败率 + 延迟桶分布 + P99 近似（桶上界，>30s 或无数据为 null）。"""
    return await opsmetrics.summary(days)


@router.get("/storage-snapshots")
async def storage_snapshots_history(
    days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
):
    """存储用量趋势（PRD-STORAGE-2 存储监控面板）：按 category 分组返回时间序列。
    数据由 `app/core/storage_snapshots.py`/`video_cache_gc.py` 的定时任务落地，
    不是实时统计——判断要不要给某类加配额上限，得看这条曲线的真实走势。"""
    from app.models import StorageCategorySnapshot
    cutoff = now_utc() - timedelta(days=days)
    rows = (await db.execute(
        select(StorageCategorySnapshot)
        .where(StorageCategorySnapshot.taken_at >= cutoff)
        .order_by(StorageCategorySnapshot.taken_at)
    )).scalars().all()
    by_category: dict[str, list[dict]] = {}
    for r in rows:
        by_category.setdefault(r.category, []).append({
            "taken_at": iso_utc(r.taken_at),
            "object_count": r.object_count,
            "total_bytes": r.total_bytes,
        })
    return {"categories": by_category, "disk": _disk_usage_if_local()}


def _disk_usage_if_local() -> dict | None:
    """磁盘剩余空间——**只有 Local 存储后端才有意义**：OSS 是按量计费的对象
    存储，没有"盘满"这个概念，硬凑一个数字反而误导（该关心的是费用增长，不是
    容量）。用 `shutil.disk_usage()`（底层 statvfs，同步但极快，不用丢线程池）。"""
    from app.core.config import get_settings
    cfg = get_settings()
    if cfg.storage.backend == "oss":
        return None
    try:
        import shutil
        from pathlib import Path
        usage = shutil.disk_usage(Path(cfg.storage.local_path).resolve())
        return {"total_bytes": usage.total, "used_bytes": usage.used, "free_bytes": usage.free}
    except Exception:
        return None
