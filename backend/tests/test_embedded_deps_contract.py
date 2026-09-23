"""内置依赖（GUGU_EMBEDDED_DEPS）部署契约测试。

一体化镜像默认内置 PostgreSQL/Redis（单容器一键部署），Compose 显式关闭走外部服务；
入口脚本在 /data 落于 overlay 可写层时必须拒绝启动（持久化守卫）。
"""
import os
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_unified_image_defaults_to_embedded_deps():
    dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert "GUGU_EMBEDDED_DEPS=1" in dockerfile, "一体化镜像必须默认开启内置依赖"
    for package in ("postgresql", "redis-server", "supervisor"):
        assert package in dockerfile, f"镜像必须安装内置依赖 {package}"
    assert "/data" in dockerfile and "VOLUME" in dockerfile, "必须声明 /data 卷兜底持久化"


def test_integrated_compose_uses_embedded_deps():
    compose = yaml.safe_load((REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
    services = compose["services"]
    assert services["app"]["environment"]["GUGU_EMBEDDED_DEPS"] == "1"
    assert "updater" in services, "一体化 Compose 必须包含受限 updater"
    app_mounts = services["app"]["volumes"]
    assert not any("docker.sock" in str(mount) for mount in app_mounts), "Web app 不得挂载 Docker Socket"
    assert any("docker.sock" in str(mount) for mount in services["updater"]["volumes"])
    assert any("legacy_pgdata:/legacy-pgdata:ro" == mount for mount in app_mounts)
    assert any("legacy_redisdata:/legacy-redisdata:ro" == mount for mount in app_mounts)


def test_entrypoint_embedded_block_refuses_overlay_data_dir():
    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")
    assert 'GUGU_EMBEDDED_DEPS:-0' in entrypoint, "入口必须保留内置依赖分支"
    assert "overlay" in entrypoint, "入口必须检查 /data 文件系统，拒绝写进 overlay 可写层"
    assert "/var/lib/docker/volumes/" in entrypoint, "匿名卷模式必须默认拒绝启动（绑定宿主机目录），仅显式开关放行"
    assert "GUGU_ALLOW_ANONYMOUS_DATA:-0" in entrypoint, "匿名卷放行必须走显式环境变量，不能静默"
    assert "EMBEDDED_SUPERVISORD_PID" in entrypoint, "内置依赖进程必须纳入关键进程托管"
    assert "LEGACY_PGDATA_FOUND" in entrypoint, "必须探测旧 Compose PostgreSQL 数据卷"
    assert "LEGACY_REDIS_FOUND" in entrypoint, "必须探测旧 Compose Redis 持久数据"
    assert "拒绝初始化空数据库" in entrypoint, "旧库尚未迁移时必须 fail-closed"
    assert "legacy-postgres.imported" in entrypoint, "旧库成功导入后必须记录幂等标记"


def test_legacy_compose_migration_script_requires_quiesced_app_and_exports_both_stores():
    script = (REPO_ROOT / "scripts" / "migrate-compose-postgres.sh").read_text(encoding="utf-8")
    assert "pg_dump --no-owner --no-privileges" in script
    assert "ps --all -q app" in script and "ps --status running -q app" in script
    assert "--rdb" in script and "legacy-redis.rdb" in script
    assert "chmod 600" in script
    assert "docker compose" in script
    assert "down -v" not in script
    assert "volume rm" not in script


def test_single_image_entrypoint_lets_persisted_database_password_win_over_empty_image_env():
    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")

    assert 'unset DB__PASSWORD' in entrypoint
    assert 'export DB__PASSWORD="$GUGU_DB_PASSWORD"' in entrypoint
    assert 'unset GUGU_DB_PASSWORD' in entrypoint


def _run_readiness_helper(
    tmp_path: Path,
    *,
    helper: Path,
    command_script: str,
    timeout_seconds: int,
):
    service = helper.stem.removeprefix("wait_embedded_")
    command_name, timeout_env, pass_command_path = {
        "postgres": ("pg_isready", "GUGU_EMBEDDED_PG_WAIT_SECONDS", True),
        "redis": ("redis-cli", "GUGU_EMBEDDED_REDIS_WAIT_SECONDS", False),
    }[service]
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    command = fake_bin / command_name
    command.write_text(command_script, encoding="utf-8")
    command.chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        timeout_env: str(timeout_seconds),
    }
    args = ["sh", str(helper)]
    if pass_command_path:
        args.append(str(command))
    return subprocess.run(args, env=env, capture_output=True, text=True, check=False)


def test_embedded_redis_readiness_helper_is_called_before_app_start():
    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")

    wait_call = entrypoint.index("gugu-wait-embedded-redis.sh")
    app_start = entrypoint.index('echo "[entrypoint] 启动: $*"')

    assert wait_call < app_start


@pytest.mark.parametrize(
    ("service", "ready_message"),
    [("redis", "内置 Redis 已就绪"), ("postgres", "内置 PostgreSQL 已就绪")],
)
def test_embedded_service_readiness_waits_until_ready(tmp_path: Path, service: str, ready_message: str):
    helper = REPO_ROOT / "backend" / "scripts" / f"wait_embedded_{service}.sh"
    call_count = tmp_path / f"{service}-readiness-calls"
    ready_output = "printf 'PONG\\n'" if service == "redis" else ":"
    result = _run_readiness_helper(
        tmp_path,
        helper=helper,
        command_script=(
            "#!/bin/sh\n"
            f"count_file='{call_count}'\n"
            "count=$(cat \"$count_file\" 2>/dev/null || printf 0)\n"
            "count=$((count + 1))\n"
            "printf '%s' \"$count\" > \"$count_file\"\n"
            "if [ \"$count\" -eq 1 ]; then exit 1; fi\n"
            f"{ready_output}\n"
            "exit 0\n"
        ),
        timeout_seconds=3,
    )

    assert result.returncode == 0
    assert call_count.read_text(encoding="utf-8") == "2"
    assert ready_message in result.stdout


@pytest.mark.parametrize(
    ("service", "timeout_message"),
    [
        ("redis", "等待内置 Redis 完成数据加载超时（1s）"),
        ("postgres", "等待内置 PostgreSQL 就绪超时（1s）"),
    ],
)
def test_embedded_service_readiness_fails_clearly_on_timeout(
    tmp_path: Path,
    service: str,
    timeout_message: str,
):
    helper = REPO_ROOT / "backend" / "scripts" / f"wait_embedded_{service}.sh"
    result = _run_readiness_helper(
        tmp_path,
        helper=helper,
        command_script="#!/bin/sh\nexit 1\n",
        timeout_seconds=1,
    )

    assert result.returncode == 1
    assert timeout_message in result.stderr


def test_embedded_postgres_readiness_guard_runs_before_createdb_and_app_start():
    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")
    dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")

    wait_call = entrypoint.index("gugu-wait-embedded-postgres.sh")
    createdb_call = entrypoint.index("$PG_BIN/createdb", wait_call)
    app_start = entrypoint.index('echo "[entrypoint] 启动: $*"')

    assert wait_call < createdb_call < app_start
    assert (
        "COPY backend/scripts/wait_embedded_postgres.sh "
        "/usr/local/bin/gugu-wait-embedded-postgres.sh" in dockerfile
    )
    assert "chmod 755" in dockerfile
    assert "/usr/local/bin/gugu-wait-embedded-postgres.sh" in dockerfile
