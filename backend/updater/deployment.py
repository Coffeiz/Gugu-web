"""部署拓扑识别与更新能力判定。

识别只读取部署标识和应用包运行状态，不执行 Docker 操作。Compose 始终由管理器更新；
未知或互相矛盾的信号一律关闭 Admin 应用包更新。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

MODES = {"integrated_compose", "split_compose", "standalone_docker", "standalone_app_bundle", "unknown"}


def detect_deployment() -> dict[str, Any]:
    explicit = os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE", "").strip().lower()
    unified = os.getenv("GUGU_UNIFIED_APP", "0").strip() == "1"
    embedded = os.getenv("GUGU_EMBEDDED_DEPS", "0").strip() == "1"
    project_value = os.getenv("GUGU_UPDATER_COMPOSE_DIR", "")
    project = Path(project_value).resolve() if project_value else Path.cwd().resolve()
    compose_name = os.getenv("GUGU_UPDATER_COMPOSE_FILE", "docker-compose.yml")
    compose_exists = Path(compose_name).name == compose_name and (project / compose_name).is_file()
    enabled_by_config = os.getenv("GUGU_SELF_UPDATE", "on").strip().lower() not in {
        "off", "0", "false", "no",
    }

    if explicit and explicit not in MODES - {"unknown"}:
        return _result("unknown", False, "deployment_mode_invalid", "部署模式标识无效；为避免误操作，自动更新已关闭。")
    if explicit in MODES - {"unknown"}:
        mode = explicit
        if mode == "standalone_docker":
            # 旧配置中该模式代表无 Compose 的单容器；整镜像升级现在交给 Docker 管理器。
            mode = "standalone_app_bundle"
    elif unified and embedded:
        mode = "integrated_compose" if compose_exists else "standalone_app_bundle"
    elif unified and compose_exists:
        mode = "integrated_compose"
    else:
        mode = "unknown"

    if mode in {"integrated_compose", "split_compose"}:
        return _result(mode, False, "manual_image_update", "Compose 部署由 Docker/Compose 管理器更新整套镜像；Admin 不执行镜像更新。")
    if mode == "standalone_app_bundle":
        if not enabled_by_config:
            return _result(mode, False, "self_update_disabled", "GUGU_SELF_UPDATE 已关闭；请由 NAS Docker 管理器更新整镜像。")
        try:
            from updater.app_bundle_runtime import supports_app_bundle_updates

            supported = supports_app_bundle_updates()
        except Exception:
            supported = False
        if supported:
            return _result(mode, True, "ready", "可在线更新 Gugu 应用包；整镜像由 fnOS、群晖等 Docker 管理器更新。")
        return _result(mode, False, "app_bundle_unavailable", "当前容器未完成应用包运行目录初始化；请由 NAS Docker 管理器更新整镜像。")
    return _result("unknown", False, "deployment_unrecognized", "无法可靠识别部署拓扑；为避免误操作，自动更新已关闭。")


def _result(mode: str, enabled: bool, reason_code: str, reason: str) -> dict[str, Any]:
    return {
        "mode": mode,
        "enabled": enabled,
        "capability": "one_click" if enabled else "manual",
        "reason_code": reason_code,
        "reason": reason,
    }
