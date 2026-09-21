"""内置依赖（GUGU_EMBEDDED_DEPS）部署契约测试。

一体化镜像默认内置 PostgreSQL/Redis（单容器一键部署），Compose 显式关闭走外部服务；
入口脚本在 /data 落于 overlay 可写层时必须拒绝启动（持久化守卫）。
"""
from pathlib import Path
import os
import subprocess

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_unified_image_defaults_to_embedded_deps():
    dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert "GUGU_EMBEDDED_DEPS=1" in dockerfile, "一体化镜像必须默认开启内置依赖"
    for package in ("postgresql", "redis-server", "supervisor"):
        assert package in dockerfile, f"镜像必须安装内置依赖 {package}"
    assert "/data" in dockerfile and "VOLUME" in dockerfile, "必须声明 /data 卷兜底持久化"


def test_compose_explicitly_disables_embedded_deps():
    compose = (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert 'GUGU_EMBEDDED_DEPS: "0"' in compose, "默认 Compose 必须显式关闭内置依赖"


def test_entrypoint_embedded_block_refuses_overlay_data_dir():
    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")
    assert 'GUGU_EMBEDDED_DEPS:-0' in entrypoint, "入口必须保留内置依赖分支"
    assert "overlay" in entrypoint, "入口必须检查 /data 文件系统，拒绝写进 overlay 可写层"
    assert "/var/lib/docker/volumes/" in entrypoint, "匿名卷模式必须默认拒绝启动（绑定宿主机目录），仅显式开关放行"
    assert "GUGU_ALLOW_ANONYMOUS_DATA:-0" in entrypoint, "匿名卷放行必须走显式环境变量，不能静默"
    assert "EMBEDDED_SUPERVISORD_PID" in entrypoint, "内置依赖进程必须纳入关键进程托管"


def test_single_image_entrypoint_lets_persisted_database_password_win_over_empty_image_env():
    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")

    assert 'unset DB__PASSWORD' in entrypoint
    assert 'export DB__PASSWORD="$GUGU_DB_PASSWORD"' in entrypoint
    assert 'unset GUGU_DB_PASSWORD' in entrypoint


def test_embedded_redis_readiness_waits_through_loading_state(tmp_path: Path):
    helper = REPO_ROOT / "backend" / "scripts" / "wait_embedded_redis.sh"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    call_count = tmp_path / "redis-cli-calls"
    redis_cli = fake_bin / "redis-cli"
    redis_cli.write_text(
        "#!/bin/sh\n"
        f"count_file='{call_count}'\n"
        "count=$(cat \"$count_file\" 2>/dev/null || printf 0)\n"
        "count=$((count + 1))\n"
        "printf '%s' \"$count\" > \"$count_file\"\n"
        "if [ \"$count\" -eq 1 ]; then printf 'LOADING Redis is loading the dataset in memory\\n'; exit 1; fi\n"
        "printf 'PONG\\n'\n",
        encoding="utf-8",
    )
    redis_cli.chmod(0o755)
    env = {**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}", "GUGU_EMBEDDED_REDIS_WAIT_SECONDS": "3"}

    result = subprocess.run(["bash", str(helper)], env=env, capture_output=True, text=True, check=False)

    assert result.returncode == 0
    assert call_count.read_text(encoding="utf-8") == "2"
    assert "内置 Redis 已就绪" in result.stdout


def test_embedded_redis_readiness_helper_is_called_before_app_start():
    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")

    wait_call = entrypoint.index("gugu-wait-embedded-redis.sh")
    app_start = entrypoint.index('echo "[entrypoint] 启动: $*"')

    assert wait_call < app_start


def test_embedded_redis_readiness_fails_clearly_when_loading_exceeds_timeout(tmp_path: Path):
    helper = REPO_ROOT / "backend" / "scripts" / "wait_embedded_redis.sh"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    redis_cli = fake_bin / "redis-cli"
    redis_cli.write_text("#!/bin/sh\nprintf 'LOADING\\n'\nexit 1\n", encoding="utf-8")
    redis_cli.chmod(0o755)
    env = {**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}", "GUGU_EMBEDDED_REDIS_WAIT_SECONDS": "1"}

    result = subprocess.run(["bash", str(helper)], env=env, capture_output=True, text=True, check=False)

    assert result.returncode == 1
    assert "等待内置 Redis 完成数据加载超时（1s）" in result.stderr
