"""由目标应用镜像启动的一次性 helper，安全交接并重建 Compose updater。"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any


_TARGET_IMAGE = re.compile(r"^(?:docker\.io|ghcr\.io)/coffeiz/gugu-web@sha256:[0-9a-f]{64}$")
_COMMAND_TIMEOUT_SECONDS = 90 * 60


def _read_state(path: Path, task_id: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("updater handoff 状态不可读") from exc
    task = value.get("task") if isinstance(value, dict) else None
    if (
        not isinstance(task, dict)
        or task.get("id") != task_id
        or task.get("status") != "recreating_pending_restart"
    ):
        raise RuntimeError("updater handoff 状态不匹配")
    target = str(task.get("updater_image") or "")
    if not _TARGET_IMAGE.fullmatch(target) or task.get("app_image") != target:
        raise RuntimeError("updater handoff 镜像目标无效")
    return task


def _compose_prefix(project_dir: Path, compose_file: Path) -> list[str]:
    if not project_dir.is_dir() or not compose_file.is_file() or compose_file.parent != project_dir:
        raise RuntimeError("updater handoff Compose 路径无效")
    return [
        "docker", "compose", "--project-directory", str(project_dir),
        "-f", str(compose_file), "--profile", "sandbox",
    ]


def _run(command: list[str], *, cwd: Path, env: dict[str, str]) -> str:
    try:
        result = subprocess.run(
            command, cwd=cwd, env=env, check=True,
            capture_output=True, text=True, timeout=_COMMAND_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        # Compose/Docker stderr can contain deployment configuration; do not echo it.
        raise RuntimeError("Compose updater handoff 命令失败") from exc
    return result.stdout


def run() -> None:
    task_id = os.getenv("GUGU_UPDATER_HANDOFF_TASK_ID", "")
    if not re.fullmatch(r"[0-9a-f-]{36}", task_id):
        raise RuntimeError("updater handoff task id 无效")
    project_dir = Path(os.getenv("GUGU_UPDATER_COMPOSE_DIR", "")).resolve()
    compose_name = os.getenv("GUGU_UPDATER_COMPOSE_FILE", "docker-compose.yml")
    if Path(compose_name).name != compose_name or not compose_name.endswith((".yml", ".yaml")):
        raise RuntimeError("updater handoff Compose 文件名无效")
    compose_file = project_dir / compose_name
    state_dir = Path(os.getenv("GUGU_UPDATER_STATE_DIR", "/data/updater")).resolve()
    task = _read_state(state_dir / "state.json", task_id)
    target_image = str(task["updater_image"])
    if os.getenv("GUGU_WEB_IMAGE") != target_image:
        raise RuntimeError("updater handoff 环境镜像与持久状态不一致")

    prefix = _compose_prefix(project_dir, compose_file)
    env = os.environ.copy()
    config = json.loads(_run([*prefix, "config", "--format", "json"], cwd=project_dir, env=env))
    updater_image = str((config.get("services", {}).get("updater") or {}).get("image") or "")
    if updater_image != target_image:
        raise RuntimeError("Compose updater 服务未指向目标镜像")

    _run([*prefix, "up", "-d", "--no-deps", "--force-recreate", "updater"], cwd=project_dir, env=env)
    container_ids = _run([*prefix, "ps", "-q", "updater"], cwd=project_dir, env=env).splitlines()
    if len(container_ids) != 1:
        raise RuntimeError("Compose updater 重建后容器数量异常")
    actual_image = _run(
        ["docker", "inspect", "--format", "{{.Config.Image}}", container_ids[0]],
        cwd=project_dir, env=env,
    ).strip()
    if actual_image != target_image:
        raise RuntimeError("Compose updater 容器镜像与目标不一致")


def main() -> None:
    run()


if __name__ == "__main__":
    main()
