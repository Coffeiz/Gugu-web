from __future__ import annotations

import socket
import uuid
from pathlib import Path

from updater.deployment import detect_deployment


def test_detect_integrated_compose_requires_socket_and_switch(tmp_path, monkeypatch):
    (tmp_path / "docker-compose.yml").write_text("services: {app: {}, postgres: {}, redis: {}}\n", encoding="utf-8")
    socket_path = tmp_path / "docker.sock"
    socket_path.touch()
    monkeypatch.setenv("GUGU_UPDATER_COMPOSE_DIR", str(tmp_path))
    monkeypatch.setenv("GUGU_DOCKER_SOCKET", str(socket_path))
    monkeypatch.setenv("GUGU_UNIFIED_APP", "1")
    monkeypatch.setenv("GUGU_EMBEDDED_DEPS", "0")
    monkeypatch.setenv("GUGU_SELF_UPDATE", "on")

    result = detect_deployment()

    assert result == {
        "mode": "integrated_compose", "enabled": True, "capability": "one_click",
        "reason_code": "ready", "reason": "一体化 Compose 更新已就绪。",
    }

    monkeypatch.setenv("GUGU_SELF_UPDATE", "off")
    assert detect_deployment()["reason_code"] == "self_update_disabled"


def test_detect_split_and_standalone_report_their_capabilities(tmp_path, monkeypatch):
    (tmp_path / "docker-compose.prod.yml").write_text(
        "services: {postgres: {}, redis: {}, migrate: {}, backend: {}, worker: {}, gateway: {}, frontend: {}, nginx: {}}\n",
        encoding="utf-8",
    )
    socket_path = tmp_path / "docker.sock"
    socket_path.touch()
    monkeypatch.setenv("GUGU_UPDATER_COMPOSE_DIR", str(tmp_path))
    monkeypatch.setenv("GUGU_UPDATER_COMPOSE_FILE", "docker-compose.prod.yml")
    monkeypatch.setenv("GUGU_DOCKER_SOCKET", str(socket_path))
    monkeypatch.setenv("GUGU_UPDATE_DEPLOYMENT_MODE", "split_compose")
    assert detect_deployment()["reason_code"] == "split_updater_unavailable"

    rpc_path = Path("/tmp") / f"gugu-updater-{uuid.uuid4().hex[:8]}.sock"
    rpc = socket.socket(socket.AF_UNIX)
    rpc.bind(str(rpc_path))
    try:
        monkeypatch.setenv("GUGU_UPDATER_RPC_SOCKET", str(rpc_path))
        result = detect_deployment()
        assert result["enabled"] is True
        assert result["reason_code"] == "ready"
    finally:
        rpc.close()
        rpc_path.unlink()

    monkeypatch.setenv("GUGU_UPDATE_DEPLOYMENT_MODE", "standalone_docker")
    monkeypatch.setenv("GUGU_DOCKER_SOCKET", str(socket_path))
    monkeypatch.setenv("GUGU_SELF_UPDATE", "on")
    assert detect_deployment() == {
        "mode": "standalone_docker", "enabled": True, "capability": "one_click",
        "reason_code": "ready", "reason": "纯 Docker 单容器 helper 更新已就绪。",
    }

    monkeypatch.setenv("GUGU_DOCKER_SOCKET", str(tmp_path / "missing.sock"))
    assert detect_deployment()["reason_code"] == "docker_socket_missing"


def test_compose_missing_and_ambiguous_topology_are_not_reported_as_disabled_only(tmp_path, monkeypatch):
    monkeypatch.setenv("GUGU_UPDATER_COMPOSE_DIR", str(tmp_path))
    monkeypatch.setenv("GUGU_UPDATE_DEPLOYMENT_MODE", "integrated_compose")
    assert detect_deployment()["reason_code"] == "compose_missing"

    (tmp_path / "docker-compose.yml").write_text("services: [broken\n", encoding="utf-8")
    assert detect_deployment()["reason_code"] == "compose_invalid"

    monkeypatch.delenv("GUGU_UPDATE_DEPLOYMENT_MODE")
    monkeypatch.setenv("GUGU_UNIFIED_APP", "0")
    monkeypatch.setenv("GUGU_EMBEDDED_DEPS", "0")
    assert detect_deployment()["reason_code"] == "deployment_unrecognized"
