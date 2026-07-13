"""项目领域的写入底座。

项目更新必须把版本比较放进同一条 ``UPDATE``：先读版本再 ORM commit 会留下
并发窗口，两个请求可能同时通过比较并互相覆盖。网页 API 与咕咕工具都应经由
这里执行写入；调用方根据返回值决定是否向用户报告冲突。
"""
from __future__ import annotations

from datetime import date
from typing import Any, Dict
import json

from sqlalchemy import func, update

from app.core.tz import now_utc
from app.models import Project

_PROJECT_FIELDS = {
    "name", "client", "status", "start_date", "deadline", "color", "progress",
    "current_stage", "archived", "priority", "stages",
}
_PROJECT_STATUSES = {"pending", "active", "done"}
_PROJECT_PRIORITIES = {"high", "medium", "low"}


def _validate_date(value: Any, field: str) -> None:
    if value is not None:
        try:
            date.fromisoformat(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field} 必须是 YYYY-MM-DD 格式") from exc


def prepare_project_update(fields: Dict[str, Any]) -> Dict[str, Any]:
    """校验并转换项目可写字段，供 API 和工具共用。"""
    unknown = set(fields) - _PROJECT_FIELDS
    if unknown:
        raise ValueError("包含不支持的项目字段")

    values = dict(fields)
    if "status" in values and values["status"] not in _PROJECT_STATUSES:
        raise ValueError("项目状态必须是 pending、active 或 done")
    if "priority" in values and values["priority"] not in _PROJECT_PRIORITIES | {None}:
        raise ValueError("优先级必须是 high、medium、low 或空")
    if "progress" in values and (not isinstance(values["progress"], int) or not 0 <= values["progress"] <= 100):
        raise ValueError("项目进度必须是 0 到 100 的整数")
    _validate_date(values.get("start_date"), "开始日期")
    _validate_date(values.get("deadline"), "截止日期")
    if "stages" in values:
        stages = values.pop("stages")
        if not isinstance(stages, list) or not all(isinstance(stage, dict) for stage in stages):
            raise ValueError("项目阶段必须是对象列表")
        values["stages_json"] = json.dumps(stages, ensure_ascii=False)
    return values


async def update_project_atomic(
    db,
    project_id: int,
    user_id,
    client_version: int,
    fields: Dict[str, Any],
) -> bool:
    """按版本原子更新项目；``False`` 表示资源不存在、无权或版本已经变化。"""
    values = prepare_project_update(fields)
    if not values:
        return False

    if "status" in values:
        values["done_at"] = (
            func.coalesce(Project.done_at, now_utc()) if values["status"] == "done" else None
        )
    values["version"] = Project.version + 1
    values["updated_at"] = now_utc()
    result = await db.execute(
        update(Project)
        .where(
            Project.id == project_id,
            Project.user_id == user_id,
            Project.version == client_version,
        )
        .values(**values)
    )
    return result.rowcount == 1
