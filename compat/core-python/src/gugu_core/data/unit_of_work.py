"""统一 SQL 事务及宿主映射装配；借用会话不会隐式提交。"""
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import AsyncIterator, Callable

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from gugu_core.application.clients import ClientService
from gugu_core.application.context import DataContext
from gugu_core.application.data import DataServices
from gugu_core.application.projects import ProjectService
from gugu_core.clock import now_utc
from gugu_core.data.clients import SqlClientRepository
from gugu_core.data.config import DataRuntimeConfig, create_runtime_engine, create_session_factory
from gugu_core.data.models import LocalClient, LocalProject
from gugu_core.data.projects import SqlProjectRepository


@dataclass(frozen=True)
class DataModels:
    project: type = LocalProject
    client: type = LocalClient


def bind_services(
    session: AsyncSession, context: DataContext, *, models: DataModels = DataModels(),
    clock: Callable[[], datetime] = now_utc,
) -> DataServices:
    """接入已有宿主事务；调用方保留 commit/rollback、事件和撤销编排。"""
    return DataServices(
        projects=ProjectService(SqlProjectRepository(session, context.owner_id, model=models.project, clock=clock)),
        clients=ClientService(SqlClientRepository(session, context.owner_id, model=models.client)),
    )


class SqlDataRuntime:
    def __init__(self, engine: AsyncEngine, *, models: DataModels = DataModels()):
        self.engine, self.models = engine, models
        self.sessions = create_session_factory(engine)
        self._closed = False

    @classmethod
    def connect(cls, config: DataRuntimeConfig, *, models: DataModels = DataModels()) -> "SqlDataRuntime":
        """仅创建连接管理，不创建表、不执行迁移。"""
        return cls(create_runtime_engine(config), models=models)

    @asynccontextmanager
    async def transaction(self, context: DataContext) -> AsyncIterator[DataServices]:
        if self._closed:
            raise RuntimeError("数据运行时已关闭")
        async with self.sessions.begin() as session:
            yield bind_services(session, context, models=self.models)

    async def close(self) -> None:
        self._closed = True
        await self.engine.dispose()
