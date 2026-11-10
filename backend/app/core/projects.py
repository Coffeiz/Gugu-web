"""Web 项目兼容入口；校验和原子写入由 Core 维护。"""
from typing import Any, Dict

from gugu_core.application.projects import apply_project_update
from gugu_core.data.projects import SqlProjectRepository
from gugu_core.domain.projects import (
    find_project_stage, next_project_stage_key, next_project_todo_number,
    normalize_project_stages, prepare_project_create, prepare_project_update,
    replace_project_stages,
)

from app.core.tz import now_utc
from app.models import Project


def build_project(user_id, fields: Dict[str, Any]) -> Project:
    """调用方保留幂等、撤销、事件和事务提交编排。"""
    return Project(user_id=user_id, **prepare_project_create(fields))


async def update_project_atomic(
    db,
    project_id: int,
    user_id,
    client_version: int,
    fields: Dict[str, Any],
    existing_project: Project | None = None,
) -> bool:
    repository = SqlProjectRepository(db, user_id, model=Project, clock=now_utc)
    return await apply_project_update(repository, project_id, client_version, fields, existing_project)
