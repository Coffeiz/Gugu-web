from __future__ import annotations

from pathlib import Path

import yaml

from updater.deployment import detect_deployment


REPO_ROOT = Path(__file__).resolve().parents[4]


def test_supported_compose_files_have_no_updater_service_or_host_socket_mount():
    for filename in ("docker-compose.yml", "docker-compose.prod.yml"):
        config = yaml.safe_load((REPO_ROOT / filename).read_text(encoding="utf-8"))
        services = config["services"]
        assert "updater" not in services
        serialized = str(services)
        assert "/var/run/docker.sock" not in serialized
        assert "/run/gugu-updater" not in serialized


def test_integrated_compose_is_manual_and_does_not_require_updater_service(tmp_path, monkeypatch):
    (tmp_path / "docker-compose.yml").write_text(
        "services: {app: {environment: {GUGU_EMBEDDED_DEPS: '1'}}}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("GUGU_UPDATER_COMPOSE_DIR", str(tmp_path))
    monkeypatch.setenv("GUGU_UNIFIED_APP", "1")
    monkeypatch.setenv("GUGU_EMBEDDED_DEPS", "0")
    monkeypatch.setenv("GUGU_UPDATE_DEPLOYMENT_MODE", "integrated_compose")
    monkeypatch.setenv("GUGU_SELF_UPDATE", "on")

    result = detect_deployment()

    assert result == {
        "mode": "integrated_compose", "enabled": False, "capability": "manual",
        "reason_code": "manual_image_update",
        "reason": "Compose 部署由 Docker/Compose 管理器更新整套镜像；Admin 不执行镜像更新。",
    }

    monkeypatch.setenv("GUGU_SELF_UPDATE", "off")
    assert detect_deployment()["reason_code"] == "manual_image_update"


def test_explicit_compose_mode_does_not_need_socket_rpc_or_compose_mount(monkeypatch):
    monkeypatch.setenv("GUGU_UPDATE_DEPLOYMENT_MODE", "integrated_compose")
    monkeypatch.setenv("GUGU_UNIFIED_APP", "1")
    monkeypatch.setenv("GUGU_EMBEDDED_DEPS", "0")
    monkeypatch.setenv("GUGU_UPDATER_RPC_SOCKET", "/nonexistent/updater.sock")
    monkeypatch.setenv("GUGU_DOCKER_SOCKET", "/nonexistent/docker.sock")

    assert detect_deployment()["reason_code"] == "manual_image_update"


def test_split_compose_is_manual_and_single_container_uses_app_bundle(tmp_path, monkeypatch):
    (tmp_path / "docker-compose.prod.yml").write_text(
        "services: {postgres: {}, redis: {}, migrate: {}, backend: {}, worker: {}, gateway: {}, frontend: {}, nginx: {}}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("GUGU_UPDATER_COMPOSE_DIR", str(tmp_path))
    monkeypatch.setenv("GUGU_UPDATER_COMPOSE_FILE", "docker-compose.prod.yml")
    monkeypatch.setenv("GUGU_UPDATE_DEPLOYMENT_MODE", "split_compose")
    assert detect_deployment()["reason_code"] == "manual_image_update"

    monkeypatch.setenv("GUGU_DOCKER_SOCKET", str(tmp_path / "host-docker.sock"))
    monkeypatch.setenv("GUGU_UPDATE_DEPLOYMENT_MODE", "standalone_docker")
    monkeypatch.setenv("GUGU_SELF_UPDATE", "on")
    monkeypatch.setattr("updater.app_bundle_runtime.supports_app_bundle_updates", lambda: True)
    result = detect_deployment()
    assert result["mode"] == "standalone_app_bundle"
    assert result["enabled"] is True
    assert result["reason_code"] == "ready"


def test_compose_mode_is_manual_but_unknown_topology_stays_fail_closed(monkeypatch):
    monkeypatch.setenv("GUGU_UPDATE_DEPLOYMENT_MODE", "integrated_compose")
    assert detect_deployment()["reason_code"] == "manual_image_update"

    monkeypatch.delenv("GUGU_UPDATE_DEPLOYMENT_MODE")
    monkeypatch.setenv("GUGU_UNIFIED_APP", "0")
    monkeypatch.setenv("GUGU_EMBEDDED_DEPS", "0")
    assert detect_deployment()["reason_code"] == "deployment_unrecognized"
