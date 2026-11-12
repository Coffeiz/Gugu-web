"""独立文件库的持久化、事务和身份边界，不依赖 Web 登录或真实配置。"""
from uuid import uuid4
import asyncio
import json
import os
import sqlite3
import subprocess
import sys

import pytest

from gugu_core.application.projects import ProjectConflict, ProjectNotFound, ProjectService
from gugu_core.data.projects import SqlProjectRepository
from gugu_core.data.runtime import LocalRuntime, RuntimeSchemaError


@pytest.fixture
async def runtime(tmp_path):
    runtime = await LocalRuntime.initialize(tmp_path / "项目 空间.db")
    try:
        yield runtime
    finally:
        await runtime.close()


async def test_local_projects_persist_identity_and_version_after_reopen(tmp_path):
    path = tmp_path / "项目 # 空间.db"
    runtime = await LocalRuntime.initialize(path)
    owner = runtime.owner_id
    try:
        async with runtime.transaction() as projects:
            created = await projects.create({"name": "离线项目"})
            changed = await projects.update(created.id, created.version, {"name": "整理计划"})
        assert changed.version == 2
        assert changed.updated_at.tzinfo is not None
    finally:
        await runtime.close()

    runtime = await LocalRuntime.open(path)
    try:
        assert runtime.owner_id == owner
        async with runtime.transaction() as projects:
            rows = await projects.list()
        assert [(row.name, row.version, row.user_id) for row in rows] == [("整理计划", 2, owner)]
        with sqlite3.connect(path) as connection:
            assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "users" not in tables
    finally:
        await runtime.close()


async def test_failed_unit_of_work_rolls_back_every_project(runtime):
    with pytest.raises(ValueError, match="名称不能为空"):
        async with runtime.transaction() as projects:
            await projects.create({"name": "不能留下的半成品"})
            await projects.create({"name": ""})
    async with runtime.transaction() as projects:
        assert await projects.list() == []


async def test_concurrent_rename_commits_only_one_writer(runtime):
    async with runtime.transaction() as projects:
        created = await projects.create({"name": "初始名称"})

    async def rename(name):
        try:
            async with runtime.transaction() as projects:
                changed = await projects.update(created.id, 1, {"name": name})
            return changed.name
        except ProjectConflict:
            return None

    results = await asyncio.gather(rename("先写计划"), rename("另一计划"))
    winners = [name for name in results if name is not None]
    assert len(winners) == 1
    async with runtime.transaction() as projects:
        rows = await projects.list()
    assert [(row.name, row.version) for row in rows] == [(winners[0], 2)]


async def test_scoped_repository_hides_and_rejects_other_owner(runtime):
    async with runtime.transaction() as projects:
        created = await projects.create({"name": "本地计划"})
    async with runtime.sessions.begin() as session:
        outsider = ProjectService(SqlProjectRepository(session, uuid4()))
        assert await outsider.list() == []
        with pytest.raises(ProjectNotFound, match="项目不存在"):
            await outsider.update(created.id, created.version, {"name": "越权修改"})
    async with runtime.transaction() as projects:
        assert (await projects.list())[0].name == "本地计划"


async def test_partial_update_keeps_date_and_stage_invariants(runtime):
    async with runtime.transaction() as projects:
        with pytest.raises(ValueError, match="当前阶段必须属于阶段列表"):
            await projects.create({"name": "缺少阶段的计划", "current_stage": "s0"})
        created = await projects.create({
            "name": "分期计划", "start_date": "2026-11-01", "deadline": "2026-11-10",
            "stages": [{"key": "s0", "label": "准备", "todos": []}], "current_stage": "s0",
        })
        with pytest.raises(ValueError, match="开始日期不能晚于截止日期"):
            await projects.update(created.id, 1, {"start_date": "2026-11-11"})
        with pytest.raises(ValueError, match="当前阶段必须属于阶段列表"):
            await projects.update(created.id, 1, {"current_stage": "missing"})
        changed = await projects.update(created.id, 1, {"name": "准备完成", "status": "done"})
        repeated = await projects.update(created.id, 2, {"status": "done"})
        assert changed.done_at == repeated.done_at
        assert repeated.version == 3
        assert repeated.stages == created.stages


async def test_archive_listing_excludes_active_projects(runtime):
    async with runtime.transaction() as projects:
        created = await projects.create({"name": "归档计划"})
        await projects.update(created.id, 1, {"archived": True})
        assert await projects.list() == []
        assert [row.id for row in await projects.list(archived=True)] == [created.id]


async def test_initialize_never_overwrites_existing_file(tmp_path):
    path = tmp_path / "existing.db"
    path.write_bytes(b"existing-user-data")
    with pytest.raises(FileExistsError):
        await LocalRuntime.initialize(path)
    assert path.read_bytes() == b"existing-user-data"


async def test_open_missing_database_does_not_create_it(tmp_path):
    path = tmp_path / "missing.db"
    with pytest.raises(FileNotFoundError):
        await LocalRuntime.open(path)
    assert not path.exists()


async def test_open_unknown_or_future_database_refuses_implicit_migration(tmp_path):
    path = tmp_path / "unknown.db"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE user_data (value TEXT)")
        connection.execute("INSERT INTO user_data VALUES ('保留内容')")
    original = path.read_bytes()
    with pytest.raises(RuntimeSchemaError, match="不是已初始化"):
        await LocalRuntime.open(path)
    assert path.read_bytes() == original

    future = tmp_path / "future.db"
    runtime = await LocalRuntime.initialize(future)
    await runtime.close()
    with sqlite3.connect(future) as connection:
        connection.execute("UPDATE core_runtime_meta SET value='999' WHERE key='schema_version'")
    original = future.read_bytes()
    with pytest.raises(RuntimeSchemaError, match="版本不兼容"):
        await LocalRuntime.open(future)
    assert future.read_bytes() == original


async def test_open_rejects_damaged_project_schema_without_repairing_it(tmp_path):
    path = tmp_path / "damaged.db"
    runtime = await LocalRuntime.initialize(path)
    await runtime.close()
    with sqlite3.connect(path) as connection:
        connection.execute("ALTER TABLE projects DROP COLUMN summary")
    original = path.read_bytes()
    with pytest.raises(RuntimeSchemaError, match="表结构不兼容"):
        await LocalRuntime.open(path)
    assert path.read_bytes() == original


@pytest.mark.process
async def test_process_exit_discards_uncommitted_wal_transaction(tmp_path):
    path = tmp_path / "recovery.db"
    runtime = await LocalRuntime.initialize(path)
    async with runtime.transaction() as projects:
        await projects.create({"name": "已提交计划"})
    await runtime.close()
    script = """
import asyncio, os, sys
from pathlib import Path
from gugu_core.data.runtime import LocalRuntime
async def crash():
    runtime = await LocalRuntime.open(Path(sys.argv[1]))
    async with runtime.transaction() as projects:
        await projects.create({"name": "未提交计划"})
        os._exit(13)
asyncio.run(crash())
"""
    result = subprocess.run([sys.executable, "-c", script, str(path)], capture_output=True, timeout=15)
    assert result.returncode == 13, result.stderr
    runtime = await LocalRuntime.open(path)
    try:
        async with runtime.transaction() as projects:
            assert [row.name for row in await projects.list()] == ["已提交计划"]
        with sqlite3.connect(path) as connection:
            assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        await runtime.close()


@pytest.mark.process
def test_core_cli_creates_and_renames_without_web_host(tmp_path):
    path = tmp_path / "cli.db"

    def run(*args):
        return subprocess.run(
            [sys.executable, "-m", "gugu_core", "--database", str(path), *args],
            capture_output=True, text=True, encoding="utf-8",
            env={**os.environ, "PYTHONUTF8": "0", "PYTHONIOENCODING": "ascii"},
            timeout=15,
        )

    assert run("init").returncode == 0
    created = run("create", "命令行计划")
    assert created.returncode == 0, created.stderr
    project = json.loads(created.stdout)
    renamed = run("rename", str(project["id"]), "已改名", "--version", "1")
    assert renamed.returncode == 0, renamed.stderr
    conflict = run("rename", str(project["id"]), "过期写入", "--version", "1")
    assert conflict.returncode == 2
    assert "项目已变化" in conflict.stderr
    assert [(row["name"], row["version"]) for row in json.loads(run("list").stdout)] == [("已改名", 2)]
