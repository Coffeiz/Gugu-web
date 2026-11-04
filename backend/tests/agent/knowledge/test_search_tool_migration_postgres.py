"""真实 PostgreSQL 上验证搜索迁移 DDL；临时 schema 随事务回滚。"""
import importlib.util
import os
from pathlib import Path
from uuid import uuid4

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.ext.asyncio import create_async_engine


@pytest.mark.external_service
async def test_search_upgrade_downgrade_postgres():
    url = os.environ.get("GUGU_TEST_POSTGRES_URL")
    if not url:
        pytest.skip("需要显式提供 PostgreSQL 测试连接")
    engine = create_async_engine(url)
    path = Path(__file__).parents[3] / "alembic/versions/20261018000001_migrate_search_tool_references.py"
    spec = importlib.util.spec_from_file_location("search_pg_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                schema = "test_search_migration_" + uuid4().hex
                await connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
                await connection.execute(sa.text(f'SET LOCAL search_path TO "{schema}"'))
                for sql in (
                    "CREATE TABLE user_provider_credentials (id integer PRIMARY KEY)",
                    "CREATE TABLE user_bots (id integer PRIMARY KEY, group_allowed_tools jsonb DEFAULT '[\"web_search\"]'::jsonb)",
                    "CREATE TABLE user_skills (id integer PRIMARY KEY, related_tools jsonb)",
                    "CREATE TABLE conversation_sessions (id integer PRIMARY KEY, session_context jsonb)",
                    "INSERT INTO user_provider_credentials VALUES (1)",
                    "INSERT INTO user_bots VALUES (1, '[\"web_search\",\"image_search\",\"read_file\"]')",
                    "INSERT INTO user_skills VALUES (1, '[\"web_search\"]')",
                    "INSERT INTO conversation_sessions VALUES (1, '{\"other\": true,\"user_skill_snapshot\":[{\"related_tools\":[\"image_search\"]}]}')",
                ):
                    await connection.execute(sa.text(sql))

                def apply(sync_connection, action):
                    with Operations.context(MigrationContext.configure(sync_connection)):
                        action()

                await connection.run_sync(apply, module.upgrade)
                assert (await connection.execute(sa.text("SELECT web_search_enabled FROM user_provider_credentials WHERE id=1"))).scalar_one() is False
                await connection.execute(sa.text("INSERT INTO user_provider_credentials(id) VALUES (2)"))
                assert (await connection.execute(sa.text("SELECT web_search_enabled FROM user_provider_credentials WHERE id=2"))).scalar_one() is False
                column = (await connection.execute(sa.text("SELECT is_nullable FROM information_schema.columns WHERE table_schema=:schema AND table_name='user_provider_credentials' AND column_name='web_search_enabled'"), {"schema": schema})).scalar_one()
                assert column == "NO"
                assert (await connection.execute(sa.text("SELECT group_allowed_tools FROM user_bots WHERE id=1"))).scalar_one() == ["xng_search", "similar_image_search", "read_file"]
                assert (await connection.execute(sa.text("SELECT related_tools FROM user_skills WHERE id=1"))).scalar_one() == ["xng_search"]
                context = (await connection.execute(sa.text("SELECT session_context FROM conversation_sessions WHERE id=1"))).scalar_one()
                assert context == {"other": True, "user_skill_snapshot": [{"related_tools": ["xng_search", "similar_image_search"]}]}
                await connection.execute(sa.text("INSERT INTO user_bots(id) VALUES (2)"))
                assert (await connection.execute(sa.text("SELECT group_allowed_tools FROM user_bots WHERE id=2"))).scalar_one() == ["xng_search"]
                await connection.run_sync(apply, module.downgrade)
                assert (await connection.execute(sa.text("SELECT count(*) FROM information_schema.columns WHERE table_schema=:schema AND table_name='user_provider_credentials' AND column_name='web_search_enabled'"), {"schema": schema})).scalar_one() == 0
                await connection.execute(sa.text("INSERT INTO user_bots(id) VALUES (3)"))
                assert (await connection.execute(sa.text("SELECT group_allowed_tools FROM user_bots WHERE id=3"))).scalar_one() == ["web_search"]
                assert (await connection.execute(sa.text("SELECT group_allowed_tools FROM user_bots WHERE id=1"))).scalar_one() == ["web_search", "image_search", "read_file"]
                await connection.run_sync(apply, module.upgrade)
                assert (await connection.execute(sa.text("SELECT web_search_enabled FROM user_provider_credentials WHERE id=1"))).scalar_one() is False
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()
