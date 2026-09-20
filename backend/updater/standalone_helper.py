"""由目标 unified 镜像启动的短期 helper，脱离 app 生命周期替换单容器。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from updater.standalone import DockerEngine, DockerReplaceRecovered, write_sensitive_json


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("更新 handoff 文件格式无效")
    return value


def _update_task(state_path: Path, task_id: str, *, status: str, stage: str, message: str, failure_code: str | None = None, current: dict[str, Any] | None = None) -> None:
    state = _read_object(state_path)
    task = state.get("task")
    if not isinstance(task, dict) or task.get("id") != task_id:
        raise RuntimeError("更新 handoff 与持久化任务不匹配")
    task.update({
        "status": status, "stage": stage,
        "progress": 100 if status == "succeeded" else task.get("progress", 75),
        "message": message, "failure_code": failure_code,
        "updated_at": _now(), "completed_at": _now() if status in {"succeeded", "failed", "rollback_required"} else None,
    })
    task.setdefault("events", []).append({"stage": stage, "at": _now()})
    history = state.setdefault("history", [])
    for index, row in enumerate(history):
        if isinstance(row, dict) and row.get("id") == task_id:
            history[index] = dict(task)
            break
    if current is not None:
        state["current"] = current
    write_sensitive_json(state_path, state)


def _backup_database(handoff: dict[str, Any], backup_path: Path) -> None:
    if backup_path.is_file() and backup_path.stat().st_size > 0:
        with backup_path.open("rb") as stream:
            if b"PostgreSQL database cluster dump" in stream.read(4096):
                return
    snapshot = handoff["snapshot"]
    env = snapshot["config"]["Env"]
    db_user = str(env.get("DB__USER") or "gugu")
    if not db_user or len(db_user) > 128:
        raise RuntimeError("内置数据库用户名无效，拒绝更新")
    backup_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(backup_path.parent, 0o700)
    with backup_path.open("wb") as output:
        os.chmod(backup_path, 0o600)
        process = subprocess.Popen(
            ["docker", "exec", str(snapshot["container_id"]), "pg_dumpall", "-U", db_user],
            stdout=output, stderr=subprocess.PIPE,
        )
        try:
            _stderr, _ = process.communicate(timeout=300)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            backup_path.unlink(missing_ok=True)
            raise RuntimeError("数据库备份超时")
        output.flush()
        os.fsync(output.fileno())
        if process.returncode != 0:
            backup_path.unlink(missing_ok=True)
            raise RuntimeError("数据库备份失败，更新已中止")
    with backup_path.open("rb") as stream:
        if b"PostgreSQL database cluster dump" not in stream.read(4096):
            backup_path.unlink(missing_ok=True)
            raise RuntimeError("数据库备份校验失败，更新已中止")


def run() -> int:
    handoff_path = Path(os.getenv("GUGU_UPDATER_HANDOFF_FILE", ""))
    if not handoff_path.is_absolute() or not handoff_path.is_file():
        raise RuntimeError("standalone handoff 文件不存在")
    handoff = _read_object(handoff_path)
    task_id = str(handoff.get("task_id") or "")
    image = str(handoff.get("image") or "")
    state_path = Path(os.getenv("GUGU_UPDATER_STATE_DIR", "/data/updater")) / "state.json"
    backup_path = Path(str(handoff.get("database_backup") or ""))
    if not task_id or not image or not backup_path.is_absolute():
        raise RuntimeError("standalone handoff 参数无效")
    try:
        state = _read_object(state_path)
        existing = state.get("task")
        if not isinstance(existing, dict) or existing.get("id") != task_id:
            raise RuntimeError("更新 handoff 与持久化任务不匹配")
        if existing.get("status") in {"succeeded", "failed", "rollback_required"}:
            return 0
        _backup_database(handoff, backup_path)
        _update_task(state_path, task_id, status="recreating", stage="recreating", message="数据库备份已验证，正在替换应用容器。")
        engine = DockerEngine(os.getenv("GUGU_DOCKER_SOCKET", "/var/run/docker.sock"))

        def handoff_before_replace() -> None:
            _update_task(
                state_path, task_id, status="recreating_pending_restart",
                stage="recreating_pending_restart", message="更新已交接给独立 helper，正在重建应用容器。",
            )

        engine.replace_container(
            handoff["snapshot"], image, task_id,
            before_replacement=handoff_before_replace,
            pull_image=handoff.get("pull_image") is True,
        )
        _update_task(
            state_path, task_id, status="succeeded", stage="succeeded",
            message="单容器更新完成，应用健康检查通过。",
            current={"version": handoff["version"], "image": image},
        )
        return 0
    except DockerReplaceRecovered:
        _update_task(
            state_path, task_id, status="failed", stage="failed",
            message="新容器未通过验证，已自动恢复原容器；数据库未自动回滚。",
            failure_code="update_rolled_back",
        )
        return 1
    except Exception as exc:
        # 仅当原容器仍以原镜像运行时标记普通失败；否则保留 rollback_required。
        recovered_before_change = False
        try:
            snapshot = handoff.get("snapshot") or {}
            old = DockerEngine(os.getenv("GUGU_DOCKER_SOCKET", "/var/run/docker.sock")).maybe_inspect_container(
                str(snapshot.get("container_name") or ""),
            )
            recovered_before_change = bool(
                old and old.get("State", {}).get("Running")
                and old.get("Config", {}).get("Image") == snapshot.get("image")
            )
        except Exception:
            pass
        # 不记录异常文本：Docker/子进程异常可能包含用户配置或 registry 响应。
        _update_task(
            state_path, task_id,
            status="failed" if recovered_before_change else "rollback_required",
            stage="failed" if recovered_before_change else "rollback_required",
            message=("更新在替换容器前失败，原容器仍正常运行。" if recovered_before_change else "单容器 helper 未能确认更新结果；旧容器、数据卷与备份已保留，请检查更新器日志。"),
            failure_code="update_failed_before_replace" if recovered_before_change else type(exc).__name__,
        )
        return 1


def main() -> None:
    try:
        raise SystemExit(run())
    except SystemExit:
        raise
    except Exception as exc:
        # 日志只保留异常类型，不输出敏感配置。
        print(f"standalone updater helper failed: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
