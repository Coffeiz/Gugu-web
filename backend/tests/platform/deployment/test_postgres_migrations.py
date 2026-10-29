"""手动 Docker 集成：验证 PostgreSQL 初始化与 Alembic 数据库迁移。"""
import asyncio
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from uuid import UUID, uuid4

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.ext.asyncio import create_async_engine

BACKEND = Path(__file__).resolve().parents[3]
pytestmark = [
    pytest.mark.process,
    pytest.mark.external_service,
    pytest.mark.skipif(
        os.environ.get("GUGU_RUN_DOCKER_INTEGRATION") != "1",
        reason="需显式启用隔离 Docker 集成测试",
    ),
]


def _run(*args, **kwargs):
    try:
        return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)
    except subprocess.CalledProcessError as exc:
        raise AssertionError(exc.stderr or exc.stdout) from exc


@pytest.mark.parametrize("legacy_schema_without_version", [False, True])
def test_postgres_bootstrap_installs_custom_search_and_paging_objects(
    tmp_path, legacy_schema_without_version,
):
    """空库和无 Alembic 版本表的旧 schema 都会安装自定义搜索/分页对象。"""
    container = f"gugu-empty-db-test-{uuid4().hex[:12]}"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{Path(sys.executable).parent}:{os.environ['PATH']}",
        "PYTHONPATH": str(BACKEND),
        "GUGU_DATA_DIR": str(tmp_path / "data"),
        "GUGU_CONFIG_OVERRIDE_FILE": str(tmp_path / "unused-config.json"),
        "DB__HOST": "127.0.0.1",
        "DB__NAME": "synthetic",
        "DB__USER": "synthetic",
        "DB__PASSWORD": "synthetic-test-only",
    }
    config = (BACKEND / "alembic.ini").read_text().replace(
        "script_location = alembic", f"script_location = {BACKEND / 'alembic'}",
    )
    (tmp_path / "alembic.ini").write_text(config)
    try:
        _run("docker", "run", "-d", "--name", container,
             "--publish", "127.0.0.1::5432",
             "--env", "POSTGRES_USER=synthetic", "--env", "POSTGRES_DB=synthetic",
             "--env", "POSTGRES_PASSWORD=synthetic-test-only", "postgres:18-alpine")
        for _ in range(60):
            ready = subprocess.run(["docker", "exec", container, "pg_isready", "-U", "synthetic"],
                                   capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(0.5)
        else:
            pytest.fail("临时 PostgreSQL 未就绪")

        info = json.loads(_run("docker", "inspect", container).stdout)[0]
        env["DB__PORT"] = info["NetworkSettings"]["Ports"]["5432/tcp"][0]["HostPort"]
        if legacy_schema_without_version:
            _run(
                sys.executable,
                "-c",
                "import asyncio; from app.db.session import create_all_tables; asyncio.run(create_all_tables())",
                env=env,
                cwd=BACKEND,
            )
            old_version = _run(
                "docker", "exec", container, "psql", "-U", "synthetic", "-d", "synthetic", "-Atc",
                "SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema() "
                "AND table_name = 'alembic_version'",
            ).stdout.strip()
            assert old_version == "0"
            old_page_indexes = _run(
                "docker", "exec", container, "psql", "-U", "synthetic", "-d", "synthetic", "-Atc",
                "SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() AND "
                "(indexname LIKE 'ix_files_page_%' OR indexname LIKE 'ix_folders_page_%')",
            ).stdout.strip()
            assert old_page_indexes == "0"
        migration = subprocess.run(
            ["bash", str(BACKEND / "scripts/migrations/bootstrap_database.sh")],
            env=env, cwd=BACKEND, capture_output=True, text=True,
        )
        assert migration.returncode == 0, migration.stderr

        collation = _run("docker", "exec", container, "psql", "-U", "synthetic", "-d", "synthetic",
                         "-Atc", "SELECT count(*) FROM pg_collation WHERE collname = 'gugu_natural_zh'").stdout.strip()
        assert collation == "1"
        file_indexes = _run(
            "docker", "exec", container, "psql", "-U", "synthetic", "-d", "synthetic", "-Atc",
            "SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() "
            "AND indexname LIKE 'ix_files_page_%'",
        ).stdout.strip()
        assert file_indexes == "6"
        folder_indexes = _run(
            "docker", "exec", container, "psql", "-U", "synthetic", "-d", "synthetic", "-Atc",
            "SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() "
            "AND indexname LIKE 'ix_folders_page_%'",
        ).stdout.strip()
        assert folder_indexes == "2"
        version = _run("docker", "exec", container, "psql", "-U", "synthetic", "-d", "synthetic",
                       "-Atc", "SELECT version_num FROM alembic_version").stdout.strip()
        assert version == "20261012000004"
    finally:
        subprocess.run(["docker", "rm", "-f", "-v", container], capture_output=True)


def test_postgres_skill_id_migration_preserves_uuid_owner_binding():
    """真实 PostgreSQL UUID 主键可在迁移后正确回填稳定 Skill ID 与用户序列。"""
    container = f"gugu-skill-id-test-{uuid4().hex[:12]}"
    owner_id = UUID("00000000-0000-0000-0000-000000000001")
    try:
        _run("docker", "run", "-d", "--name", container,
             "--publish", "127.0.0.1::5432",
             "--env", "POSTGRES_USER=synthetic", "--env", "POSTGRES_DB=synthetic",
             "--env", "POSTGRES_PASSWORD=synthetic-test-only", "postgres:18-alpine")
        for _ in range(60):
            ready = subprocess.run(["docker", "exec", container, "pg_isready", "-U", "synthetic"],
                                   capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(0.5)
        else:
            pytest.fail("临时 PostgreSQL 未就绪")

        info = json.loads(_run("docker", "inspect", container).stdout)[0]
        port = info["NetworkSettings"]["Ports"]["5432/tcp"][0]["HostPort"]
        engine = create_async_engine(
            f"postgresql+asyncpg://synthetic:synthetic-test-only@127.0.0.1:{port}/synthetic",
            connect_args={"ssl": False},
        )
        migration_path = BACKEND / "alembic/versions/20261013000001_use_skill_ids.py"
        migration_spec = importlib.util.spec_from_file_location(
            "skill_id_migration_postgres", migration_path,
        )
        assert migration_spec is not None and migration_spec.loader is not None
        migration = importlib.util.module_from_spec(migration_spec)
        migration_spec.loader.exec_module(migration)

        def prepare(connection):
            connection.exec_driver_sql("CREATE TABLE users (id UUID PRIMARY KEY)")
            connection.exec_driver_sql(
                "CREATE TABLE user_skills (id INTEGER PRIMARY KEY, owner_id UUID NOT NULL, "
                "slug VARCHAR(80) NOT NULL, created_at TIMESTAMP NOT NULL, "
                "CONSTRAINT uq_user_skill_owner_slug UNIQUE(owner_id, slug))"
            )
            connection.exec_driver_sql("INSERT INTO users(id) VALUES ($1)", (owner_id,))
            connection.exec_driver_sql(
                "INSERT INTO user_skills(id, owner_id, slug, created_at) VALUES "
                "(1, $1, 'first', TIMESTAMP '2026-02-01'), "
                "(2, $1, 'second', TIMESTAMP '2026-02-02')",
                (owner_id,),
            )

        def run_migration(connection):
            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
            rows = connection.exec_driver_sql(
                "SELECT skill_id FROM user_skills ORDER BY id"
            ).scalars().all()
            counter = connection.exec_driver_sql(
                "SELECT next_skill_sequence FROM users WHERE id = $1", (owner_id,)
            ).scalar_one()
            assert rows == ["U1", "U2"]
            assert counter == 3

        async def exercise():
            try:
                for _ in range(60):
                    try:
                        async with engine.connect() as connection:
                            await connection.execute(sa.text("SELECT 1"))
                        break
                    except Exception:
                        await asyncio.sleep(0.5)
                else:
                    logs = subprocess.run(
                        ["docker", "logs", container], capture_output=True, text=True,
                    )
                    pytest.fail(f"临时 PostgreSQL 主机端口未就绪：{logs.stderr or logs.stdout}")
                async with engine.begin() as connection:
                    await connection.run_sync(prepare)
                    await connection.run_sync(run_migration)
            finally:
                await engine.dispose()

        asyncio.run(exercise())
    finally:
        subprocess.run(["docker", "rm", "-f", "-v", container], capture_output=True)
