from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from updater import compose_updater_helper as helper


def _setup(tmp_path: Path, monkeypatch, *, service_image: str | None = None):
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    (project_dir / "docker-compose.yml").write_text("services: {updater: {}}\n", encoding="utf-8")
    state_dir = tmp_path / "data" / "updater"
    state_dir.mkdir(parents=True)
    image = f"docker.io/coffeiz/gugu-web@sha256:{'a' * 64}"
    (state_dir / "state.json").write_text(json.dumps({
        "schema": 1,
        "task": {
            "id": "12345678-1234-1234-1234-123456789abc",
            "status": "recreating_pending_restart",
            "app_image": image,
            "updater_image": image,
        },
    }), encoding="utf-8")
    monkeypatch.setenv("GUGU_UPDATER_HANDOFF_TASK_ID", "12345678-1234-1234-1234-123456789abc")
    monkeypatch.setenv("GUGU_UPDATER_COMPOSE_DIR", str(project_dir))
    monkeypatch.setenv("GUGU_UPDATER_COMPOSE_FILE", "docker-compose.yml")
    monkeypatch.setenv("GUGU_UPDATER_STATE_DIR", str(state_dir))
    monkeypatch.setenv("GUGU_WEB_IMAGE", image)
    return project_dir, image, service_image or image


def test_helper_recreates_only_updater_with_the_validated_target(tmp_path, monkeypatch):
    project_dir, image, _ = _setup(tmp_path, monkeypatch)
    calls = []

    def run(command, *, cwd, env, **_kwargs):
        calls.append(command)
        if command[-3:] == ["config", "--format", "json"]:
            output = json.dumps({"services": {"updater": {"image": image}}})
        elif command[-3:] == ["ps", "-q", "updater"]:
            output = "container-id\n"
        elif command[:2] == ["docker", "inspect"]:
            output = image + "\n"
        else:
            output = ""
        assert cwd == project_dir
        assert env["GUGU_WEB_IMAGE"] == image
        return SimpleNamespace(stdout=output)

    monkeypatch.setattr(helper.subprocess, "run", run)

    helper.run()

    assert calls[0][-3:] == ["config", "--format", "json"]
    assert "--force-recreate" in calls[1]
    assert calls[1][-5:] == ["up", "-d", "--no-deps", "--force-recreate", "updater"]
    assert calls[1][-1] == "updater"


def test_helper_refuses_to_recreate_a_differently_configured_updater(tmp_path, monkeypatch):
    different_image = f"docker.io/coffeiz/gugu-web@sha256:{'b' * 64}"
    project_dir, _image, service_image = _setup(tmp_path, monkeypatch, service_image=different_image)
    calls = []

    def run(command, *, cwd, env, **_kwargs):
        calls.append(command)
        return SimpleNamespace(stdout=json.dumps({"services": {"updater": {"image": service_image}}}))

    monkeypatch.setattr(helper.subprocess, "run", run)

    with pytest.raises(RuntimeError, match="未指向目标镜像"):
        helper.run()

    assert len(calls) == 1
    assert calls[0][-3:] == ["config", "--format", "json"]
