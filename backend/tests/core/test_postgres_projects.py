"""显式启用的 PostgreSQL 契约验证；只在独立临时 schema 中建表。"""
from uuid import uuid4
import os

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.schema import CreateSchema, DropSchema

from gugu_core.application.projects import ProjectConflict, ProjectService
from gugu_core.data.models import LocalBase, LocalProject
from gugu_core.data.projects import SqlProjectRepository

pytestmark = [
    pytest.mark.external_service,
    pytest.mark.skipif(not os.environ.get("GUGU_CORE_TEST_POSTGRES_URL"), reason="需显式提供隔离 PostgreSQL 测试连接"),
]


async def test_postgres_project_transaction_alias_utc_and_version_contract():
    url = os.environ["GUGU_CORE_TEST_POSTGRES_URL"]
    schema = "core_test_" + uuid4().hex
    admin = create_async_engine(url)
    engine = None
    created_schema = False
    try:
        async with admin.begin() as connection:
            await connection.execute(CreateSchema(schema))
        created_schema = True
        engine = create_async_engine(url, connect_args={"server_settings": {"search_path": schema}})
        async with engine.begin() as connection:
            await connection.run_sync(LocalBase.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        owner_id, outsider_id = uuid4(), uuid4()
        async with sessions.begin() as session:
            projects = ProjectService(SqlProjectRepository(session, owner_id))
            row = await projects.create({"name": "PostgreSQL 计划", "client": "合成客户"})

        async with sessions.begin() as session:
            projects = ProjectService(SqlProjectRepository(session, owner_id))
            changed = await projects.update(row.id, 1, {"status": "done"})
            assert changed.done_at.tzinfo is not None
            assert changed.client == "合成客户"

        async with sessions.begin() as session:
            projects = ProjectService(SqlProjectRepository(session, owner_id))
            with pytest.raises(ProjectConflict):
                await projects.update(row.id, 1, {"name": "过期修改"})
            outsider = SqlProjectRepository(session, outsider_id)
            assert await outsider.list() == []
            assert await outsider.update(row.id, 2, {"name": "越权修改"}) is False

        async with sessions() as session:
            projects = ProjectService(SqlProjectRepository(session, owner_id))
            await projects.create({"name": "回滚计划"})
            await session.rollback()
        async with sessions() as session:
            rows = (await session.execute(select(LocalProject))).scalars().all()
            assert [(project.name, project.version) for project in rows] == [("PostgreSQL 计划", 2)]
    finally:
        if engine is not None:
            await engine.dispose()
        if created_schema:
            async with admin.begin() as connection:
                await connection.execute(DropSchema(schema, cascade=True))
        await admin.dispose()
