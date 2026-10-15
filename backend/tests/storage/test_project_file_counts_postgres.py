"""项目文件数投影的真实 PostgreSQL 触发器集成测试。"""
import asyncio
import json
import os
import shutil
import socket
import subprocess
import time
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.project_file_counts import PROJECT_FILE_COUNT_PROJECTION_SQL, rebuild_project_file_count_projection

pytestmark = pytest.mark.skipif(
    os.environ.get("GUGU_RUN_DOCKER_INTEGRATION") != "1"
    and os.environ.get("GUGU_RUN_POSTGRES_INTEGRATION") != "1",
    reason="需显式启用隔离 PostgreSQL 集成测试",
)


def test_postgres_project_file_count_projection_tracks_file_lifecycle(tmp_path):
    """触发器覆盖创建、移动、软删/恢复、批量删除，重建后与 files 源表一致。"""
    container = f"gugu-file-count-test-{uuid4().hex[:12]}"

    def run(*args):
        result = subprocess.run(args, check=True, capture_output=True, text=True)
        return result.stdout

    async def exercise(port: str):
        engine = create_async_engine(
            f"postgresql+asyncpg://synthetic:projection-test-only@127.0.0.1:{port}/synthetic",
            connect_args={"ssl": False},
        )
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.execute(text("CREATE TABLE projects (id INTEGER PRIMARY KEY)"))
            await connection.execute(text("""
                CREATE TABLE files (
                    id INTEGER PRIMARY KEY,
                    space VARCHAR(20) NOT NULL,
                    project_id INTEGER,
                    folder_id INTEGER,
                    deleted_at TIMESTAMPTZ
                )
            """))
            for statement in PROJECT_FILE_COUNT_PROJECTION_SQL:
                await connection.execute(text(statement))
            await connection.execute(text("INSERT INTO projects(id) VALUES (1), (2)"))

        async def assert_source_matches_projection():
            async with engine.connect() as connection:
                source = dict((await connection.execute(text("""
                    SELECT project_id, count(*)::bigint
                    FROM files
                    WHERE space = 'project' AND project_id IS NOT NULL
                      AND folder_id IS NULL AND deleted_at IS NULL
                    GROUP BY project_id
                """))).all())
                projection = dict((await connection.execute(text(
                    "SELECT project_id, file_count FROM project_file_counts"
                ))).all())
                assert projection == source

        try:
            async with engine.begin() as connection:
                await connection.execute(text("""
                    INSERT INTO files(id, space, project_id, folder_id, deleted_at) VALUES
                    (1, 'project', 1, NULL, NULL),
                    (2, 'project', 1, NULL, NULL),
                    (3, 'project', 1, 9, NULL),
                    (4, 'personal', 1, NULL, NULL),
                    (5, 'project', 2, NULL, NULL)
                """))
            await assert_source_matches_projection()

            # 文件移入/移出项目根目录，并在项目之间迁移。
            async with engine.begin() as connection:
                await connection.execute(text("UPDATE files SET folder_id = NULL WHERE id = 3"))
                await connection.execute(text("UPDATE files SET project_id = 2 WHERE id = 2"))
                await connection.execute(text("UPDATE files SET folder_id = 11 WHERE id = 5"))
            await assert_source_matches_projection()

            # 软删除与恢复都通过 UPDATE transition table 更新计数。
            async with engine.begin() as connection:
                await connection.execute(text(
                    "UPDATE files SET deleted_at = now() WHERE id = 1"
                ))
            await assert_source_matches_projection()
            async with engine.begin() as connection:
                await connection.execute(text(
                    "UPDATE files SET deleted_at = NULL WHERE id = 1"
                ))
            await assert_source_matches_projection()

            # 单条硬删除和跨项目批量删除均须移除零计数投影行。
            async with engine.begin() as connection:
                await connection.execute(text("DELETE FROM files WHERE id = 3"))
                await connection.execute(text("DELETE FROM files WHERE id IN (1, 2, 5)"))
            await assert_source_matches_projection()

            # 重建从源表重算，并与投影触发器的现状一致。
            async with engine.begin() as connection:
                await connection.execute(text("""
                    INSERT INTO files(id, space, project_id, folder_id, deleted_at)
                    VALUES (6, 'project', 1, NULL, NULL), (7, 'project', 1, NULL, NULL),
                           (8, 'project', 2, NULL, NULL)
                """))
            async with sessions() as session:
                assert await rebuild_project_file_count_projection(session) == 2
            await assert_source_matches_projection()
        finally:
            await engine.dispose()

    local_mode = os.environ.get("GUGU_POSTGRES_TEST_MODE") == "local"
    if local_mode:
        initdb = shutil.which("initdb")
        pg_ctl = shutil.which("pg_ctl")
        if not initdb or not pg_ctl:
            pytest.fail("本地 PostgreSQL 模式需要 initdb 和 pg_ctl")
        data_dir = tmp_path / "postgres-data"
        port_socket = socket.socket()
        port_socket.bind(("127.0.0.1", 0))
        port = str(port_socket.getsockname()[1])
        port_socket.close()
        subprocess.run(
            [initdb, "-D", str(data_dir), "-U", "synthetic", "--auth=trust", "--no-locale"],
            check=True, capture_output=True, text=True,
        )
        subprocess.run(
            [pg_ctl, "-D", str(data_dir), "-l", str(tmp_path / "postgres.log"),
             "-o", f"-h 127.0.0.1 -p {port}", "-w", "start"],
            check=True, capture_output=True, text=True,
        )
        try:
            createdb = shutil.which("createdb")
            if not createdb:
                pytest.fail("本地 PostgreSQL 模式需要 createdb")
            subprocess.run(
                [createdb, "-h", "127.0.0.1", "-p", port, "-U", "synthetic", "synthetic"],
                check=True, capture_output=True, text=True,
            )
            asyncio.run(exercise(port))
        finally:
            subprocess.run([pg_ctl, "-D", str(data_dir), "-m", "immediate", "-w", "stop"],
                           capture_output=True, text=True)
    else:
        try:
            run(
                "docker", "run", "-d", "--name", container,
                "--publish", "127.0.0.1::5432",
                "--env", "POSTGRES_USER=synthetic", "--env", "POSTGRES_DB=synthetic",
                "--env", "POSTGRES_PASSWORD=projection-test-only", "postgres:18-alpine",
            )
            for _ in range(60):
                ready = subprocess.run(
                    ["docker", "exec", container, "pg_isready", "-U", "synthetic"], capture_output=True,
                )
                if ready.returncode == 0:
                    break
                time.sleep(0.5)
            else:
                pytest.fail("临时 PostgreSQL 未就绪")
            inspect = json.loads(run("docker", "inspect", container))[0]
            port = inspect["NetworkSettings"]["Ports"]["5432/tcp"][0]["HostPort"]
            asyncio.run(exercise(port))
        finally:
            subprocess.run(["docker", "rm", "-f", "-v", container], capture_output=True)
