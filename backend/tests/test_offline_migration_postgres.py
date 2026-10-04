"""手动 Docker 集成：真实 PostgreSQL 归档可恢复，旧工作区迁移后能通过启动门禁。"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

import pytest

BACKEND = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.skipif(
    os.environ.get("GUGU_RUN_DOCKER_INTEGRATION") != "1",
    reason="需显式启用隔离 Docker 集成测试",
)


def _run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)


def test_real_postgres_workspace_upgrade_and_backup_restore(tmp_path):
    """只创建临时容器/数据库；不接现有应用配置或数据库。"""
    container = f"gugu-offline-test-{uuid4().hex[:12]}"
    data = tmp_path / "data"
    uid = "00000000-0000-0000-0000-000000000001"
    legacy = data / "users" / uid / "workspace"
    legacy.mkdir(parents=True)
    (legacy / "keep.txt").write_text("preserved")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    env = {
        **os.environ, "PATH": f"{bin_dir}:{Path(sys.executable).parent}:{os.environ['PATH']}",
        "PYTHONPATH": str(BACKEND), "GUGU_DATA_DIR": str(data),
        "GUGU_CONFIG_OVERRIDE_FILE": str(tmp_path / "unused-config.json"),
        "STORAGE__BACKEND": "local", "STORAGE__LOCAL_PATH": str(data / "users"),
        "DB__HOST": "127.0.0.1", "DB__NAME": "synthetic", "DB__USER": "synthetic",
        "DB__PASSWORD": "synthetic-test-only", "GUGU_OFFLINE_PG_BIN": str(bin_dir),
    }
    config = (BACKEND / "alembic.ini").read_text().replace(
        "script_location = alembic", f"script_location = {BACKEND / 'alembic'}",
    )
    (tmp_path / "alembic.ini").write_text(config)
    try:
        _run("docker", "run", "-d", "--name", container,
             "--publish", "127.0.0.1::5432", "--mount", f"type=bind,source={tmp_path},target={tmp_path}",
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
        for tool in ("pg_dump", "pg_restore"):
            wrapper = bin_dir / tool
            wrapper.write_text(f'#!/bin/bash\nexec docker exec {container} {tool} "$@"\n')
            wrapper.chmod(0o755)
        # 建立带旧目录记录的合成存量库，stamp 当前 head；本例验证布局升级而非伪造旧 schema。
        _run(sys.executable, "-c", f'''
import asyncio
from uuid import UUID
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.core.config import get_settings
from app.db.base import Base
from app.models import User, WorkspaceDirectory
import onboarding.models
async def seed():
    engine=create_async_engine(get_settings().db.url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine)() as db:
        db.add(User(id=UUID("{uid}"), username="moon", email="moon@example.test", hashed_password="unused"))
        await db.flush()
        db.add(WorkspaceDirectory(user_id=UUID("{uid}"), name="默认", directory_name="workspace", is_default=True))
        await db.commit()
    await engine.dispose()
asyncio.run(seed())
''', env=env, cwd=tmp_path)
        _run(str(Path(sys.executable).parent / "alembic"), "stamp", "head", env=env, cwd=tmp_path)
        check = [sys.executable, "-m", "scripts.migrations.migrate_workspace_layout", "--allow-real-data", "--check"]
        blocked = subprocess.run(check, env=env, cwd=tmp_path, capture_output=True)
        assert blocked.returncode != 0
        _run("bash", str(BACKEND / "scripts/runtime/offline_migration.sh"), env=env, cwd=tmp_path)
        _run(*check, env=env, cwd=tmp_path)
        assert (legacy / "default/keep.txt").read_text() == "preserved"
        first_backup = next((data / "migration-backups").iterdir())
        assert not (first_backup / "recovery-required").exists()
        _run("docker", "exec", container, "createdb", "-U", "synthetic", "restored")
        _run("docker", "exec", container, "pg_restore", "-U", "synthetic", "--exit-on-error",
             "--dbname=restored", str(first_backup / "postgres.dump"))
        restored = _run("docker", "exec", container, "psql", "-U", "synthetic", "-d", "restored", "-Atc",
                        "SELECT directory_name FROM workspace_directories").stdout.strip()
        assert restored == "workspace"
        assert _run("tar", "-xOf", str(first_backup / "users.tar"), f"users/{uid}/workspace/keep.txt").stdout == "preserved"
        _run("bash", str(BACKEND / "scripts/runtime/offline_migration.sh"), env=env, cwd=tmp_path)
        assert (legacy / "default/keep.txt").read_text() == "preserved"
        assert not (legacy / "default/default").exists()
    finally:
        subprocess.run(["docker", "rm", "-f", "-v", container], capture_output=True)
