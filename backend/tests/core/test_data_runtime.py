"""统一数据运行时保护跨域事务、上下文隔离和显式升级恢复。"""
from pathlib import Path
from uuid import UUID, uuid4
import sqlite3

import pytest
from sqlalchemy import insert

from gugu_core.application.clients import ClientNotFound
from gugu_core.application.context import DataContext
from gugu_core.data.config import DataRuntimeConfig, create_runtime_engine
from gugu_core.data.models import LocalProject, RuntimeMetadata
from gugu_core.data.runtime import LocalRuntime, RuntimeSchemaError


async def test_project_and_client_commit_and_rollback_as_one_unit(tmp_path):
    runtime = await LocalRuntime.initialize(tmp_path / "unified.db")
    try:
        async with runtime.unit_of_work() as data:
            await data.projects.create({"name": "共同提交项目"})
            contact = await data.clients.create({"name": "合成联系人", "notes": "初次联系"})
        with pytest.raises(ValueError, match="联系人名称不能为空"):
            async with runtime.unit_of_work() as data:
                await data.projects.create({"name": "必须回滚项目"})
                await data.clients.update(contact.id, {"notes": "必须回滚"})
                await data.clients.create({"name": ""})
        async with runtime.unit_of_work() as data:
            assert [row.name for row in await data.projects.list()] == ["共同提交项目"]
            assert [(row.name, row.notes) for row in await data.clients.list()] == [("合成联系人", "初次联系")]
    finally:
        await runtime.close()


async def test_data_context_isolates_all_repositories_and_close_refuses_reuse(tmp_path):
    runtime = await LocalRuntime.initialize(tmp_path / "contexts.db")
    first = DataContext(runtime.owner_id)
    second = DataContext(uuid4())
    try:
        async with runtime.data.transaction(first) as data:
            await data.projects.create({"name": "私有计划"})
            client = await data.clients.create({"name": "私有联系人"})
        async with runtime.data.transaction(second) as data:
            assert await data.projects.list() == []
            assert await data.clients.list() == []
            with pytest.raises(ClientNotFound, match="联系人不存在"):
                await data.clients.update(client.id, {"notes": "越权修改"})
            with pytest.raises(ClientNotFound, match="联系人不存在"):
                await data.clients.delete(client.id)
    finally:
        await runtime.close()
    with pytest.raises(RuntimeError, match="已关闭"):
        async with runtime.unit_of_work():
            pass


async def test_cancellation_rolls_back_every_domain(tmp_path):
    import asyncio
    runtime = await LocalRuntime.initialize(tmp_path / "cancel.db")
    try:
        with pytest.raises(asyncio.CancelledError):
            async with runtime.unit_of_work() as data:
                await data.projects.create({"name": "取消项目"})
                await data.clients.create({"name": "取消联系人"})
                raise asyncio.CancelledError
        async with runtime.unit_of_work() as data:
            assert await data.projects.list() == []
            assert await data.clients.list() == []
    finally:
        await runtime.close()


async def test_sqlite_configuration_does_not_create_an_uninitialized_file(tmp_path):
    path = tmp_path / "missing.db"
    engine = create_runtime_engine(DataRuntimeConfig.sqlite(path))
    from sqlalchemy.exc import OperationalError
    try:
        with pytest.raises(OperationalError):
            async with engine.connect():
                pass
        assert not path.exists()
    finally:
        await engine.dispose()


def test_explicit_backend_configuration_rejects_mismatches_and_hides_credentials():
    config = DataRuntimeConfig.postgres("postgresql+asyncpg://synthetic:synthetic-test-only@example.invalid/synthetic")
    assert "synthetic-test-only" not in repr(config)
    with pytest.raises(ValueError, match="不匹配"):
        DataRuntimeConfig.postgres("sqlite+aiosqlite:///uninitialized.db")
    with pytest.raises(ValueError, match="参数无效"):
        DataRuntimeConfig.postgres("postgresql+asyncpg://example.invalid/synthetic", pool_size=0)
    with pytest.raises(ValueError, match="所有者 UUID"):
        DataContext("untrusted-owner")


async def make_version_one(path: Path) -> UUID:
    """用首版真实表结构创建旧库，不调用新版本初始化。"""
    path.touch(exist_ok=False)
    owner = uuid4()
    engine = create_runtime_engine(DataRuntimeConfig.sqlite(path))
    try:
        async with engine.begin() as connection:
            await connection.run_sync(lambda sync: LocalProject.__table__.create(sync))
            await connection.run_sync(lambda sync: RuntimeMetadata.__table__.create(sync))
            await connection.execute(insert(RuntimeMetadata), [
                {"key": "schema_version", "value": "1"}, {"key": "owner_id", "value": str(owner)},
            ])
            await connection.execute(insert(LocalProject).values(user_id=owner, name="保留旧项目"))
    finally:
        await engine.dispose()
    return owner


async def test_explicit_upgrade_backs_up_version_one_and_keeps_identity_and_rows(tmp_path):
    path = tmp_path / "old.db"
    owner = await make_version_one(path)
    with pytest.raises(RuntimeSchemaError, match="版本不兼容"):
        await LocalRuntime.open(path)
    backup = await LocalRuntime.migrate(path)
    assert backup.parent == path.parent
    with sqlite3.connect(backup) as connection:
        assert connection.execute("SELECT value FROM core_runtime_meta WHERE key='schema_version'").fetchone() == ("1",)
        assert connection.execute("SELECT name FROM projects").fetchone() == ("保留旧项目",)
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    runtime = await LocalRuntime.open(path)
    try:
        assert runtime.owner_id == owner
        async with runtime.unit_of_work() as data:
            assert [row.name for row in await data.projects.list()] == ["保留旧项目"]
            await data.clients.create({"name": "升级后联系人"})
    finally:
        await runtime.close()


async def test_failed_upgrade_rolls_back_schema_and_keeps_backup(tmp_path, monkeypatch):
    import gugu_core.data.migrations as migrations
    path = tmp_path / "failed-upgrade.db"
    await make_version_one(path)

    def fail_after_table_creation(_):
        raise RuntimeError("合成迁移故障")

    monkeypatch.setattr(migrations, "CreateIndex", fail_after_table_creation)
    with pytest.raises(RuntimeError, match="合成迁移故障"):
        await LocalRuntime.migrate(path)
    assert len(list(tmp_path.glob("failed-upgrade.db.backup-*.db"))) == 1
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT value FROM core_runtime_meta WHERE key='schema_version'").fetchone() == ("1",)
        assert connection.execute("SELECT name FROM projects").fetchone() == ("保留旧项目",)
        assert connection.execute("SELECT name FROM sqlite_master WHERE name='clients'").fetchall() == []
