"""运维指标端点（商用就绪评审 P0-4「从日志到看板」）。

数据来自 app/core/opsmetrics.py 的 Redis 按日聚合（dispatch 工具漏斗旁路累计）。
与 /admin/analytics（产品指标：日活/留存/漏斗）分开——这里是可靠性口径：
工具失败率、延迟分布、P99 近似。挂 require_admin（main.py include 时注入）。
"""
from fastapi import APIRouter, Query

from app.core import opsmetrics

router = APIRouter(prefix="/admin/ops", tags=["admin"])


@router.get("/summary")
async def ops_summary(days: int = Query(1, ge=1, le=14)):
    """近 N 天（默认今天）工具调用运维汇总：每工具调用量/失败数/失败率/平均耗时，
    全局失败率 + 延迟桶分布 + P99 近似（桶上界，>30s 或无数据为 null）。"""
    return await opsmetrics.summary(days)
