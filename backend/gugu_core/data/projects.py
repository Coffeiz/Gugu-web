"""项目 SQL 适配；可使用本地映射或 Web 的同结构映射与既有事务。"""
from dataclasses import fields
from datetime import datetime
from typing import Any, Callable, Dict, List
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from gugu_core.clock import now_utc
from gugu_core.data.models import LocalProject
from gugu_core.domain.project_record import ProjectRecord


def project_record(row) -> ProjectRecord:
    return ProjectRecord(**{field.name: getattr(row, field.name) for field in fields(ProjectRecord)})


class SqlProjectRepository:
    """owner_id 必须来自受信任的宿主身份解析，不能直接使用请求体中的身份。"""

    def __init__(
        self, session: AsyncSession, owner_id: UUID, *,
        model=LocalProject, clock: Callable[[], datetime] = now_utc,
    ):
        self.session = session
        self.owner_id = owner_id
        self.model = model
        self.clock = clock

    async def list_rows(self, *, archived: bool, deleted_after: datetime | None = None):
        model = self.model
        conditions = [model.user_id == self.owner_id]
        if deleted_after is not None:
            conditions.extend((model.deleted_at.is_not(None), model.deleted_at > deleted_after))
        else:
            conditions.extend((model.archived == archived, model.deleted_at.is_(None)))
        result = await self.session.execute(select(model).where(*conditions).order_by(
            model.deleted_at.desc() if deleted_after is not None else model.created_at.desc(),
            model.id.desc(),
        ))
        return result.scalars().all()

    async def list(self, *, archived: bool = False) -> List[ProjectRecord]:
        return [project_record(row) for row in await self.list_rows(archived=archived)]

    async def get(self, project_id: int) -> ProjectRecord | None:
        model = self.model
        row = (await self.session.execute(
            select(model).where(
                model.id == project_id, model.user_id == self.owner_id, model.deleted_at.is_(None),
            ).execution_options(populate_existing=True)
        )).scalar_one_or_none()
        return project_record(row) if row is not None else None

    async def create(self, values: Dict[str, Any]) -> ProjectRecord:
        row = self.model(user_id=self.owner_id, **values)
        self.session.add(row)
        await self.session.flush()
        return project_record(row)

    async def update(self, project_id: int, version: int, values: Dict[str, Any]) -> bool:
        """一条 UPDATE 比较归属、墓碑和版本；不会自行提交调用方事务。"""
        model = self.model
        changes = dict(values)
        now = self.clock()
        if "status" in changes:
            changes["done_at"] = func.coalesce(model.done_at, now) if changes["status"] == "done" else None
        changes.update(version=model.version + 1, updated_at=now)
        result = await self.session.execute(
            update(model).where(
                model.id == project_id, model.user_id == self.owner_id,
                model.deleted_at.is_(None), model.version == version,
            ).values(**changes)
        )
        return result.rowcount == 1
