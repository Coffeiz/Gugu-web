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


async def test_postgres_unified_runtime_commits_domains_and_isolates_contexts():
    from datetime import timedelta
    from sqlalchemy import text
    from gugu_core.application.context import DataContext
    from gugu_core.data.config import DataRuntimeConfig
    from gugu_core.data.unit_of_work import SqlDataRuntime

    url = os.environ["GUGU_CORE_TEST_POSTGRES_URL"]
    schema = "core_test_" + uuid4().hex
    admin = create_async_engine(url)
    runtime = None
    created = False
    try:
        async with admin.begin() as connection:
            await connection.execute(CreateSchema(schema))
        created = True
        runtime = SqlDataRuntime.connect(DataRuntimeConfig.postgres(url, schema=schema))
        async with runtime.engine.begin() as connection:
            await connection.run_sync(LocalBase.metadata.create_all)
            timeout = (await connection.execute(text(
                "SELECT current_setting('idle_in_transaction_session_timeout')::interval"
            ))).scalar_one()
            assert timeout == timedelta(minutes=1)
        owner, outsider = DataContext(uuid4()), DataContext(uuid4())
        async with runtime.transaction(owner) as data:
            await data.projects.create({"name": "统一项目"})
            await data.clients.create({"name": "统一联系人"})
        with pytest.raises(ValueError, match="联系人名称不能为空"):
            async with runtime.transaction(owner) as data:
                await data.projects.create({"name": "回滚项目"})
                await data.clients.create({"name": ""})
        async with runtime.transaction(owner) as data:
            assert [row.name for row in await data.projects.list()] == ["统一项目"]
            assert [row.name for row in await data.clients.list()] == ["统一联系人"]
        async with runtime.transaction(outsider) as data:
            assert await data.projects.list() == []
            assert await data.clients.list() == []
    finally:
        if runtime is not None:
            await runtime.close()
        if created:
            async with admin.begin() as connection:
                await connection.execute(DropSchema(schema, cascade=True))
        await admin.dispose()
