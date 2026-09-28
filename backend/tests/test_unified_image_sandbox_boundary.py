"""一体化部署的 Sandbox 管理模式与进程边界。"""

from pathlib import Path
import os
import subprocess

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_unified_image_defaults_to_enabled_embedded_manager_and_supervises_it():
    dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")
    manager_start = (REPO_ROOT / "backend/scripts/runtime/start_embedded_sandbox_manager.sh").read_text(encoding="utf-8")

    assert "GUGU_SANDBOX_MANAGER_MODE=embedded" in dockerfile
    assert "SANDBOX__ENABLED=true" in dockerfile
    assert "SANDBOX__EGRESS_ISOLATION_ENABLED=true" in dockerfile
    assert "SANDBOX__EGRESS_PROXY_URL=http://egress-proxy:3128" in dockerfile
    assert "DOCKER_HOST=unix:///var/run/docker.sock" in dockerfile
    assert "gugu-start-embedded-sandbox-manager.sh" in dockerfile
    assert 'GUGU_SANDBOX_MANAGER_MODE:-disabled' in entrypoint
    assert "[program:sandboxd]" in manager_start
    assert "/usr/local/bin/gugu-start-embedded-sandbox-manager.sh" in entrypoint
    assert "EMBEDDED_SANDBOX_SUPERVISORD_PID" in entrypoint
    assert "monitored_pids+=(\"$EMBEDDED_SANDBOX_SUPERVISORD_PID\")" not in entrypoint
    assert 'kill -TERM "$EMBEDDED_SANDBOX_SUPERVISORD_PID"' in entrypoint
    assert "其未就绪不会重启 Web/数据库" in entrypoint


def test_embedded_manager_supervisor_start_uses_isolated_paths_and_fails_closed(tmp_path):
    helper = REPO_ROOT / "backend/scripts/runtime/start_embedded_sandbox_manager.sh"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    config_capture = tmp_path / "supervisor-config-path"
    fake_supervisord = fake_bin / "supervisord"
    fake_supervisord.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "printf '%s\\n' \"$2\" > \"$GUGU_TEST_SUPERVISOR_CONFIG\"\n"
        "if [ \"$GUGU_TEST_SUPERVISOR_FAIL\" = 1 ]; then exit 1; fi\n"
        "pid_file=$(sed -n 's/^pidfile=//p' \"$2\")\n"
        "printf '4242\\n' > \"$pid_file\"\n",
        encoding="utf-8",
    )
    fake_supervisord.chmod(0o755)

    socket_path = tmp_path / "run" / "sandboxd.sock"
    allowed_root = tmp_path / "data" / "users"
    supervisor_dir = tmp_path / "run" / "sandbox-supervisor"
    base_env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "GUGU_TEST_SUPERVISOR_CONFIG": str(config_capture),
        "GUGU_TEST_SUPERVISOR_FAIL": "0",
    }
    command = ["bash", str(helper), str(socket_path), str(allowed_root), str(supervisor_dir)]

    started = subprocess.run(command, capture_output=True, text=True, env=base_env, check=False)

    assert started.returncode == 0
    assert started.stdout == "4242\n"
    assert socket_path.parent.is_dir()
    assert allowed_root.is_dir()
    config_path = Path(config_capture.read_text(encoding="utf-8").strip())
    supervisor_config = config_path.read_text(encoding="utf-8")
    assert "[program:sandboxd]" in supervisor_config
    assert f"--socket {socket_path}" in supervisor_config
    assert f"--allowed-root {allowed_root}" in supervisor_config
    assert "autorestart=true" in supervisor_config

    failed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        env={**base_env, "GUGU_TEST_SUPERVISOR_FAIL": "1"},
        check=False,
    )

    assert failed.returncode != 0
    assert "supervisor 启动失败" in failed.stderr

    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")
    manager_start = entrypoint.index("EMBEDDED_SANDBOX_SUPERVISORD_PID")
    manager_block = entrypoint[manager_start:entrypoint.index("python -m worker &", manager_start)]
    assert "Web 继续启动，Shell 将显示未就绪" in manager_block
    assert "exit " not in manager_block
    assert 'monitored_pids+=("$EMBEDDED_SANDBOX_SUPERVISORD_PID")' not in manager_block
    assert entrypoint.index('"$@" &', manager_start) > manager_start


def test_manager_mode_is_explicit_and_disabled_by_default():
    config = (REPO_ROOT / "backend" / "app" / "core" / "config.py").read_text(encoding="utf-8")
    runtime = (REPO_ROOT / "backend" / "agent" / "sandbox" / "docker_runtime.py").read_text(encoding="utf-8")

    assert 'Literal["embedded", "external", "disabled"]' in config
    # 通用 settings 保持 fail-closed；官方一体化镜像由 Dockerfile 显式开启 embedded。
    assert '"disabled"' in config[config.index("manager_mode:"):config.index("manager_mode:") + 300]
    assert "未配置管理器或 Socket 不可用时 fail-closed" in runtime


def test_unified_image_includes_entrypoint_runtime_migrations():
    dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")

    assert "COPY backend/scripts/migrations ./scripts/migrations" in dockerfile
    assert "python -m scripts.migrations.migrate_knowledge_timestamps" in entrypoint


def test_compose_deployment_modes_match_embedded_and_external_manager_contracts():
    integrated = yaml.safe_load((REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
    offline = yaml.safe_load((REPO_ROOT / "docker-compose.offline.yml").read_text(encoding="utf-8"))
    split = yaml.safe_load((REPO_ROOT / "docker-compose.prod.yml").read_text(encoding="utf-8"))

    integrated_services = integrated["services"]
    app = integrated_services["app"]
    assert app["environment"]["GUGU_SANDBOX_MANAGER_MODE"] == "embedded"
    assert app["environment"]["SANDBOX__ENABLED"] == "true"
    assert app["environment"]["DOCKER_HOST"] == "unix:///var/run/docker.sock"
    assert any("docker.sock" in str(mount) for mount in app["volumes"])
    assert "sandboxd" not in integrated_services
    assert "egress-proxy" not in integrated_services
    assert "sandbox_socket" not in integrated.get("volumes", {})

    assert set(offline["services"]) == {"app", "searxng"}
    assert "sandboxd" not in offline["services"]
    assert "egress-proxy" not in offline["services"]

    split_services = split["services"]
    for name in ("backend", "worker"):
        environment = split_services[name]["environment"]
        assert environment["GUGU_SANDBOX_MANAGER_MODE"] == "external"
        assert environment["SANDBOX__ROOTLESS_REQUIRED"] == "true"
        assert not any("docker.sock" in str(mount) for mount in split_services[name]["volumes"])
    assert "sandboxd" not in split_services
    assert "egress-proxy" not in split_services
    assert split["volumes"]["sandbox_socket"]["external"] is True


def test_compose_bootstrap_resolves_latest_to_an_immutable_digest():
    bootstrap = (REPO_ROOT / "backend" / "scripts" / "runtime" / "sandbox_rootless_init.sh").read_text(encoding="utf-8")

    assert "SANDBOX_BUNDLE_DIR" not in bootstrap
    assert '"$SANDBOX_IMAGE_DIGEST" = resolved' in bootstrap
    assert bootstrap.index('rm -f "$SANDBOX_IMAGE_DIGEST_FILE"') < bootstrap.index('$RD pull "$SANDBOX_IMAGE"')
    assert "RepoDigests" in bootstrap
    assert "python -m updater.sandbox_signature" in bootstrap
    assert bootstrap.index("python -m updater.sandbox_signature") < bootstrap.index('printf \'%s\\n\' "$resolved_digest"')
    assert "/run/gugu/sandbox-image-digest" in bootstrap
