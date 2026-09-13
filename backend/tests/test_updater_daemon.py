from __future__ import annotations

import hashlib
import json
import secrets
from types import SimpleNamespace

import pytest

from updater.daemon import UpdateDaemon
from updater.database_check import validate_revision_state


def make_daemon(tmp_path, monkeypatch, state=None):
    project = tmp_path / "deployment"
    project.mkdir()
    (project / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
    state_dir = tmp_path / "updater-state"
    state_dir.mkdir()
    monkeypatch.setenv("GUGU_UPDATER_COMPOSE_DIR", str(project))
    monkeypatch.setenv("GUGU_UPDATER_STATE_DIR", str(state_dir))
    monkeypatch.setenv("GUGU_UPDATER_CODE_DIR", str(tmp_path / "updater-code"))
    if state is not None:
        (state_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    return UpdateDaemon(), state_dir


@pytest.mark.asyncio
async def test_initial_state_status_handles_null_task(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)

    status = await daemon.dispatch({"method": "status", "params": {}})

    assert status["enabled"] is True
    assert status["task"] is None
    assert status["candidate"] is None
    assert status["has_update"] is False


def test_restart_converts_interrupted_task_to_recoverable_state(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch, {
        "schema": 1,
        "candidate": None,
        "task": {"id": "test-task", "status": "pulling", "previous_image": "docker.io/coffeiz/gugu-web@sha256:" + "a" * 64},
        "history": [],
        "challenges": [],
    })

    assert daemon.state["task"]["status"] == "rollback_required"
    assert daemon.state["task"]["failure_code"] == "updater_restarted"
    persisted = json.loads((daemon.state_dir / "state.json").read_text(encoding="utf-8"))
    assert persisted["task"]["status"] == "rollback_required"
    assert persisted["history"][0]["failure_code"] == "updater_restarted"


@pytest.mark.asyncio
async def test_preflight_rejects_unknown_current_version(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)
    (daemon.project_dir / "backend").mkdir()
    (daemon.project_dir / "backend" / ".env").write_text("ADMIN_PASSWORD=test-only-value\n", encoding="utf-8")
    daemon.state["current"] = {"version": "unknown"}
    monkeypatch.setattr("updater.daemon.shutil.disk_usage", lambda _path: SimpleNamespace(free=5 * 1024**3))

    async def command(_args, *, timeout, env=None):
        return b"x86_64"

    async def compose(_args):
        return {"services": {
            "app": {}, "postgres": {}, "redis": {}, "data-migrate": {},
            "updater": {"image": "docker.io/coffeiz/gugu-web-updater:latest"},
        }}

    async def compose_text(args, *, env=None, timeout=30):
        if args[:2] == ["ps", "-q"] and args[-1] == "app":
            return "app-container\n"
        if args[:4] == ["ps", "--status", "running", "--services"]:
            return "app\nupdater\n"
        return "ok"

    async def docker_json(args, *, timeout=30):
        if args[:1] == ["inspect"]:
            return [{"Mounts": [
                {"Destination": "/data", "RW": True},
                {"Destination": "/config", "RW": True},
            ]}]
        return []

    monkeypatch.setattr(daemon, "_command", command)
    monkeypatch.setattr(daemon, "_compose", compose)
    monkeypatch.setattr(daemon, "_compose_text", compose_text)
    monkeypatch.setattr(daemon, "_docker_json", docker_json)

    checks = await daemon._preflight_checks({
        "version": "v1.2.2",
        "minimum_version": "v1.2.1",
        "architectures": ["linux/amd64"],
    })

    by_key = {item["key"]: item for item in checks}
    assert by_key["current_version"]["ok"] is False
    assert by_key["minimum_version"]["ok"] is False
    assert by_key["updater"]["ok"] is True
    assert by_key["storage"]["ok"] is True
    assert by_key["database_migrations"]["ok"] is True

    async def compose_with_untrusted_updater(_args):
        return {"services": {
            "app": {}, "postgres": {}, "redis": {}, "data-migrate": {},
            "updater": {"image": "attacker.invalid/gugu-updater:latest"},
        }}

    async def compose_without_running_updater(args, *, env=None, timeout=30):
        if args[:2] == ["ps", "-q"] and args[-1] == "app":
            return "app-container\n"
        if args[:4] == ["ps", "--status", "running", "--services"]:
            return "app\n"
        return "ok"

    monkeypatch.setattr(daemon, "_compose", compose_with_untrusted_updater)
    monkeypatch.setattr(daemon, "_compose_text", compose_without_running_updater)
    checks = await daemon._preflight_checks({
        "version": "v1.2.2",
        "minimum_version": "v1.2.1",
        "architectures": ["linux/amd64"],
    })
    assert next(item for item in checks if item["key"] == "updater")["ok"] is False


def test_database_revision_requires_exactly_one_current_head():
    validate_revision_state(["head-a"], ["head-a"])
    with pytest.raises(RuntimeError, match="唯一 head"):
        validate_revision_state(["old-revision"], ["head-a"])
    with pytest.raises(RuntimeError, match="唯一 head"):
        validate_revision_state(["head-a", "head-b"], ["head-a", "head-b"])


def test_update_challenge_is_bound_and_consumed_once(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)
    token = secrets.token_urlsafe(48)
    digest = "b" * 64
    daemon.state["challenges"] = [{
        "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
        "operator": "admin-test",
        "action": "update",
        "version": "v1.2.2",
        "manifest_sha256": digest,
        "expires_at": 4_000_000_000,
    }]
    daemon._save()

    daemon._consume_challenge(token, "admin-test", "update", "v1.2.2", digest)

    assert daemon.state["challenges"] == []
    with pytest.raises(ValueError, match="确认已过期"):
        daemon._consume_challenge(token, "admin-test", "update", "v1.2.2", digest)


def test_challenge_cannot_be_replayed_by_another_operator(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)
    token = secrets.token_urlsafe(48)
    digest = "c" * 64
    daemon.state["challenges"] = [{
        "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
        "operator": "admin-test",
        "action": "update",
        "version": "v1.2.2",
        "manifest_sha256": digest,
        "expires_at": 4_000_000_000,
    }]

    with pytest.raises(ValueError, match="不匹配"):
        daemon._consume_challenge(token, "different-admin", "update", "v1.2.2", digest)

    assert daemon.state["challenges"] == []
