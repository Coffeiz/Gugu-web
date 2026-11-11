"""项目用例与持久化端口；事务提交由宿主控制。"""
from typing import Any, Dict, List, Protocol

from gugu_core.domain.project_record import ProjectRecord
from gugu_core.domain.projects import ProjectState, prepare_project_create, prepare_project_update


class ProjectNotFound(ValueError):
    """不存在与归属不符使用相同错误，避免枚举资源。"""


class ProjectConflict(ValueError):
    """调用方应重新读取后决定是否重新提交。"""


class ProjectRepository(Protocol):
    async def list(self, *, archived: bool) -> List[ProjectRecord]: ...
    async def get(self, project_id: int) -> ProjectRecord | None: ...
    async def create(self, values: Dict[str, Any]) -> ProjectRecord: ...
    async def update(self, project_id: int, version: int, values: Dict[str, Any]) -> bool: ...


async def apply_project_update(
    repository: ProjectRepository, project_id: int, version: int, fields: Dict[str, Any],
    existing: ProjectState | None = None,
) -> bool:
    """Web 与本地共用写入用例；沿用宿主已有状态及事务，不抢占提交权。"""
    values = prepare_project_update(fields, existing)
    return await repository.update(project_id, version, values) if values else False


class ProjectService:
    def __init__(self, repository: ProjectRepository):
        self.repository = repository

    async def list(self, *, archived: bool = False) -> List[ProjectRecord]:
        return await self.repository.list(archived=archived)

    async def create(self, fields: Dict[str, Any]) -> ProjectRecord:
        return await self.repository.create(prepare_project_create(fields))

    async def update(self, project_id: int, version: int, fields: Dict[str, Any]) -> ProjectRecord:
        existing = await self.repository.get(project_id)
        if existing is None:
            raise ProjectNotFound("项目不存在")
        if not fields:
            raise ValueError("请提供需要更新的项目字段")
        if not await apply_project_update(self.repository, project_id, version, fields, existing):
            raise ProjectConflict("项目已变化，请重新读取后再修改")
        result = await self.repository.get(project_id)
        if result is None:
            raise ProjectNotFound("项目不存在")
        return result
