"""standalone 短期 helper 的备份、handoff 与恢复状态机。"""

from __future__ import annotations

import json

import pytest

import updater.standalone_helper as helper
from updater.standalone import DockerReplaceRecovered


def _fixture(tmp_path, monkeypatch):
    task_id = "task-synthetic-001"
    old_image = "docker.io/coffeiz/gugu-web:v9.8.6"
    target_image = "docker.io/coffeiz/gugu-web@sha256:" + "a" * 64
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    state_path = state_dir / "state.json"
    handoff_path = tmp_path / "handoff.json"
    backup_path = tmp_path / "backup.sql"
    task = {
        "id": task_id, "status": "updating", "stage": "preflight",
        "progress": 50, "events": [], "updated_at": "old", "completed_at": None,
    }
    handoff = {
        "task_id": task_id, "version": "v9.8.7", "image": target_image,
        "database_backup": str(backup_path), "pull_image": False,
        "snapshot": {
            "container_id": "synthetic-old-id", "container_name": "gugu-app",
            "image": old_image,
        },
    }
    state_path.write_text(json.dumps({"task": task, "history": [task]}), encoding="utf-8")
    handoff_path.write_text(json.dumps(handoff), encoding="utf-8")
    monkeypatch.setenv("GUGU_UPDATER_HANDOFF_FILE", str(handoff_path))
    monkeypatch.setenv("GUGU_UPDATER_STATE_DIR", str(state_dir))
    monkeypatch.setenv("GUGU_DOCKER_SOCKET", "/tmp/synthetic-docker.sock")
    return task_id, old_image, state_path, handoff, backup_path


def _state(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_helper_success_persists_handoff_and_terminal_state(tmp_path, monkeypatch):
    task_id, _old_image, state_path, handoff, backup_path = _fixture(tmp_path, monkeypatch)
    backup_path.write_bytes(b"synthetic postgres backup")
    backup_calls = []
    monkeypatch.setattr(helper, "_backup_database", lambda value, path: backup_calls.append((value, path)))

    class Engine:
        def __init__(self, _socket):
            pass

        def replace_container(self, snapshot, image, received_task, *, before_replacement, pull_image):
            assert snapshot == handoff["snapshot"]
            assert image == handoff["image"]
            assert received_task == task_id
            assert pull_image is False
            before_replacement()
            return "synthetic-new-id"

    monkeypatch.setattr(helper, "DockerEngine", Engine)

    assert helper.run() == 0
    state = _state(state_path)
    assert len(backup_calls) == 1
    assert state["task"]["status"] == "succeeded"
    assert state["task"]["stage"] == "succeeded"
    assert state["current"] == {"version": "v9.8.7", "image": handoff["image"]}
    assert [event["stage"] for event in state["task"]["events"]] == ["recreating", "recreating_pending_restart", "succeeded"]
    assert state["history"][0]["status"] == "succeeded"


def test_helper_backup_failure_keeps_old_running_container_and_marks_failed(tmp_path, monkeypatch):
    task_id, old_image, state_path, _handoff, _backup_path = _fixture(tmp_path, monkeypatch)

    def fail_backup(_handoff, _path):
        raise RuntimeError("synthetic backup failure")

    class Engine:
        def __init__(self, _socket):
            pass

        def maybe_inspect_container(self, name):
            assert name == "gugu-app"
            return {"State": {"Running": True}, "Config": {"Image": old_image}}

    monkeypatch.setattr(helper, "_backup_database", fail_backup)
    monkeypatch.setattr(helper, "DockerEngine", Engine)

    assert helper.run() == 1
    task = _state(state_path)["task"]
    assert task["status"] == "failed"
    assert task["failure_code"] == "update_failed_before_replace"
    assert "原容器仍正常运行" in task["message"]


def test_helper_failed_replacement_records_recovered_old_container(tmp_path, monkeypatch):
    _task_id, old_image, state_path, handoff, _backup_path = _fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(helper, "_backup_database", lambda _handoff, path: path.write_bytes(b"synthetic postgres backup"))

    class Engine:
        def __init__(self, _socket):
            pass

        def replace_container(self, _snapshot, _image, _task, *, before_replacement, pull_image):
            before_replacement()
            raise DockerReplaceRecovered("synthetic health failure")

        def maybe_inspect_container(self, name):
            assert name == handoff["snapshot"]["container_name"]
            return {"State": {"Running": True}, "Config": {"Image": old_image}}

    monkeypatch.setattr(helper, "DockerEngine", Engine)

    assert helper.run() == 1
    task = _state(state_path)["task"]
    assert task["status"] == "failed"
    assert task["failure_code"] == "update_rolled_back"
    assert "自动恢复原容器" in task["message"]


def test_helper_uncertain_replacement_failure_requires_manual_recovery(tmp_path, monkeypatch):
    _task_id, _old_image, state_path, handoff, _backup_path = _fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(helper, "_backup_database", lambda _handoff, path: path.write_bytes(b"synthetic postgres backup"))

    class Engine:
        def __init__(self, _socket):
            pass

        def replace_container(self, _snapshot, _image, _task, *, before_replacement, pull_image):
            before_replacement()
            raise RuntimeError("synthetic uncertain docker response")

        def maybe_inspect_container(self, name):
            assert name == handoff["snapshot"]["container_name"]
            return {"State": {"Running": False}, "Config": {"Image": handoff["image"]}}

    monkeypatch.setattr(helper, "DockerEngine", Engine)

    assert helper.run() == 1
    task = _state(state_path)["task"]
    assert task["status"] == "rollback_required"
    assert task["failure_code"] == "RuntimeError"
    assert "旧容器、数据卷与备份已保留" in task["message"]
