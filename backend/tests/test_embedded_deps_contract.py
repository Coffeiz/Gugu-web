"""内置依赖（GUGU_EMBEDDED_DEPS）部署契约测试。

一体化镜像默认内置 PostgreSQL/Redis（单容器一键部署），Compose 显式关闭走外部服务；
入口脚本在 /data 落于 overlay 可写层时必须拒绝启动（持久化守卫）。
"""
from pathlib import Path

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
    assert "EMBEDDED_SUPERVISORD_PID" in entrypoint, "内置依赖进程必须纳入关键进程托管"
