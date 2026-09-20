"""部署拓扑识别与更新能力判定。

识别只读取环境和挂载，不执行 Docker 操作。未知或互相矛盾的信号一律关闭自动更新。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml


MODES = {"integrated_compose", "split_compose", "standalone_docker", "unknown"}


def detect_deployment() -> dict[str, Any]:
    explicit = os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE", "").strip().lower()
    unified = os.getenv("GUGU_UNIFIED_APP", "0").strip() == "1"
    embedded = os.getenv("GUGU_EMBEDDED_DEPS", "0").strip() == "1"
    project_value = os.getenv("GUGU_UPDATER_COMPOSE_DIR", "")
    project = Path(project_value).resolve() if project_value else Path.cwd().resolve()
    compose_name = os.getenv("GUGU_UPDATER_COMPOSE_FILE", "docker-compose.yml")
    compose_exists = Path(compose_name).name == compose_name and (project / compose_name).is_file()
    socket_value = os.getenv("GUGU_DOCKER_SOCKET", "/var/run/docker.sock")
    socket_mounted = Path(socket_value).exists()
    enabled_by_config = os.getenv("GUGU_SELF_UPDATE", "on").strip().lower() not in {
        "off", "0", "false", "no",
    }

    if explicit and explicit not in MODES - {"unknown"}:
        return _result("unknown", False, "deployment_mode_invalid", "部署模式标识无效；为避免误操作，自动更新已关闭。")
    if explicit in MODES - {"unknown"}:
        mode = explicit
    elif unified and embedded:
        mode = "standalone_docker" if not compose_exists else "integrated_compose"
    elif unified and compose_exists:
        mode = "integrated_compose"
    else:
        mode = "unknown"

    if mode == "integrated_compose" and not compose_exists:
        return _result(mode, False, "compose_missing", "未找到一体化 Compose 文件；为避免误操作，自动更新已关闭。")
    if mode == "integrated_compose":
        try:
            compose_config = yaml.safe_load((project / "docker-compose.yml").read_text(encoding="utf-8"))
            services = compose_config.get("services") if isinstance(compose_config, dict) else None
            if not isinstance(services, dict) or not {"app", "postgres", "redis"}.issubset(services):
                raise ValueError("required service missing")
        except (OSError, UnicodeError, yaml.YAMLError, ValueError):
            return _result(mode, False, "compose_invalid", "一体化 Compose 文件无法解析或缺少必需服务；自动更新已关闭。")
    if mode == "split_compose":
        try:
            compose_config = yaml.safe_load((project / compose_name).read_text(encoding="utf-8"))
            services = compose_config.get("services") if isinstance(compose_config, dict) else None
            required = {"postgres", "redis", "migrate", "backend", "worker", "gateway", "frontend", "nginx"}
            if not isinstance(services, dict) or not required.issubset(services):
                raise ValueError("required service missing")
        except (OSError, UnicodeError, yaml.YAMLError, ValueError):
            return _result(mode, False, "compose_invalid", "分体 Compose 文件无法解析或缺少必需服务；自动更新已关闭。")
        if not socket_mounted:
            return _result(mode, False, "docker_socket_missing", "未连接受限 updater 的 Docker socket；业务容器不会直接获得该权限。")
        if not enabled_by_config:
            return _result(mode, False, "self_update_disabled", "GUGU_SELF_UPDATE 已关闭；请按分体部署文档手动更新。")
        rpc_socket = Path(os.getenv("GUGU_UPDATER_RPC_SOCKET", ""))
        if rpc_socket.is_socket():
            return _result(mode, True, "ready", "分体 Compose 受限更新服务已就绪。")
        return _result(mode, False, "split_updater_unavailable", "当前分体部署未连接受限更新器；请按分体部署文档手动更新。")
    if mode == "standalone_docker":
        if not socket_mounted:
            return _result(mode, False, "docker_socket_missing", "未挂载 Docker socket；请按单容器部署文档手动更新。")
        if not enabled_by_config:
            return _result(mode, False, "self_update_disabled", "GUGU_SELF_UPDATE 已关闭；请按单容器部署文档手动更新。")
        return _result(mode, True, "ready", "纯 Docker 单容器 helper 更新已就绪。")
    if mode == "integrated_compose":
        if not socket_mounted:
            return _result(mode, False, "docker_socket_missing", "未挂载 Docker socket；请按一体化 Compose 文档手动更新。")
        if not enabled_by_config:
            return _result(mode, False, "self_update_disabled", "GUGU_SELF_UPDATE 已关闭；请按一体化 Compose 文档手动更新。")
        return _result(mode, True, "ready", "一体化 Compose 更新已就绪。")
    return _result("unknown", False, "deployment_unrecognized", "无法可靠识别部署拓扑；为避免误操作，自动更新已关闭。")


def _result(mode: str, enabled: bool, reason_code: str, reason: str) -> dict[str, Any]:
    return {
        "mode": mode,
        "enabled": enabled,
        "capability": "one_click" if enabled else "manual",
        "reason_code": reason_code,
        "reason": reason,
    }
