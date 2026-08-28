"""Docker 沙盒运行时探测测试。"""

import json
from types import SimpleNamespace

import pytest

from agent.sandbox import docker_runtime


def test_probe_reports_missing_docker(monkeypatch):
    monkeypatch.setattr(docker_runtime.shutil, "which", lambda _: None)
    status = docker_runtime.probe_docker()
    assert status.installed is False
    assert status.executor_ready is False


def test_docker_environment_prefers_current_user_rootless_socket(monkeypatch):
    monkeypatch.delenv("DOCKER_HOST", raising=False)
    monkeypatch.setattr(docker_runtime.os, "getuid", lambda: 1000)
    monkeypatch.setattr(docker_runtime.os.path, "exists", lambda path: path == "/run/user/1000/docker.sock")
    env = docker_runtime.docker_environment()
    assert env["DOCKER_HOST"] == "unix:///run/user/1000/docker.sock"


def test_docker_environment_respects_explicit_host(monkeypatch):
    monkeypatch.setenv("DOCKER_HOST", "unix:///custom/docker.sock")
    env = docker_runtime.docker_environment()
    assert env["DOCKER_HOST"] == "unix:///custom/docker.sock"


def test_probe_reports_rootless_daemon(monkeypatch):
    monkeypatch.setattr(docker_runtime.shutil, "which", lambda _: "/usr/bin/docker")

    class Completed:
        returncode = 0
        stdout = json.dumps({"ServerVersion": "27.0.0", "SecurityOptions": ["name=rootless"]})
        stderr = ""

    calls = []
    monkeypatch.setattr(docker_runtime.subprocess, "run", lambda *args, **kwargs: calls.append(kwargs) or Completed())
    status = docker_runtime.probe_docker()
    assert status.executor_ready is True
    assert status.rootless is True
    assert status.server_version == "27.0.0"
    assert "env" in calls[0]


def test_probe_does_not_treat_daemon_failure_as_ready(monkeypatch):
    monkeypatch.setattr(docker_runtime.shutil, "which", lambda _: "/usr/bin/docker")

    class Failed:
        returncode = 1
        stdout = ""
        stderr = "permission denied"

    monkeypatch.setattr(docker_runtime.subprocess, "run", lambda *args, **kwargs: Failed())
    status = docker_runtime.probe_docker()
    assert status.installed is True
    assert status.daemon_ready is False
    assert status.executor_ready is False


def test_sandbox_readiness_requires_enabled_rootless_and_digest(monkeypatch):
    settings = SimpleNamespace(
        enabled=True,
        rootless_required=True,
        network_profile="none",
        image="debian:bookworm-slim",
        image_digest="sha256:" + "a" * 64,
    )
    monkeypatch.setattr(docker_runtime, "probe_docker", lambda: docker_runtime.DockerRuntimeStatus(True, True, True))
    monkeypatch.setattr(docker_runtime, "image_available", lambda *_args, **_kwargs: True)
    assert docker_runtime.sandbox_readiness(settings)[0]

    settings.image_digest = ""
    assert docker_runtime.sandbox_readiness(settings)[0] is False
    assert docker_runtime.valid_image_digest("sha256:" + "f" * 64)
    assert not docker_runtime.valid_image_digest("sha256:" + "g" * 64)


def test_image_available_uses_current_docker_daemon(monkeypatch):
    monkeypatch.setattr(docker_runtime.shutil, "which", lambda _: "/usr/bin/docker")

    class Completed:
        returncode = 0
        stdout = "[]"
        stderr = ""

    calls = []
    monkeypatch.setattr(docker_runtime.subprocess, "run", lambda *args, **kwargs: calls.append((args, kwargs)) or Completed())
    digest = "sha256:" + "a" * 64
    assert docker_runtime.image_available("debian:bookworm-slim", digest)
    assert calls[0][0][0][0:3] == ["/usr/bin/docker", "image", "inspect"]
    assert calls[0][0][0][3] == f"debian:bookworm-slim@{digest}"


def test_image_available_rejects_invalid_digest(monkeypatch):
    monkeypatch.setattr(docker_runtime.subprocess, "run", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("不应调用 Docker")))
    assert not docker_runtime.image_available("debian:bookworm-slim", "latest")


def test_cleanup_running_sandboxes_only_removes_labeled_containers(monkeypatch):
    monkeypatch.setattr(docker_runtime.shutil, "which", lambda _: "/usr/bin/docker")

    class Listed:
        returncode = 0
        stdout = "sandbox-a\nsandbox-b\n"
        stderr = ""

    class Removed:
        returncode = 0
        stdout = "sandbox-a\nsandbox-b\n"
        stderr = ""

    calls = []
    monkeypatch.setattr(
        docker_runtime.subprocess,
        "run",
        lambda args, **kwargs: calls.append(args) or (Listed() if args[1] == "ps" else Removed()),
    )
    assert docker_runtime.cleanup_running_sandboxes() == 2
    assert calls[0] == [
        "/usr/bin/docker", "ps", "-aq", "--filter", "label=com.gugu.sandbox=true"
    ]
    assert calls[1] == ["/usr/bin/docker", "rm", "--force", "sandbox-a", "sandbox-b"]


def test_cleanup_running_sandboxes_does_not_fail_without_containers(monkeypatch):
    monkeypatch.setattr(docker_runtime.shutil, "which", lambda _: "/usr/bin/docker")

    class Empty:
        returncode = 0
        stdout = ""
        stderr = ""

    monkeypatch.setattr(docker_runtime.subprocess, "run", lambda *_args, **_kwargs: Empty())
    assert docker_runtime.cleanup_running_sandboxes() == 0


def test_sandboxd_request_round_trips_as_json():
    from agent.sandbox.protocol import ExecuteRequest

    request = ExecuteRequest("/data/user/shell", "pwd", cwd=".", timeout=4, max_output_chars=80, quota_root="/data/user/shell", quota_bytes=512)
    import json
    value = json.loads(request.to_json())
    assert value["operation"] == "execute"
    assert value["root"] == "/data/user/shell"
    assert value["command"] == "pwd"
    assert value["quota_root"] == "/data/user/shell"
    assert value["quota_bytes"] == 512


def test_sandboxd_egress_request_requires_future_expiry():
    from agent.sandbox.protocol import ExecuteRequest
    import time

    request = ExecuteRequest(
        "/data/user/shell", "curl https://example.com", network_profile="egress",
        egress_expires_at=time.time() + 60,
    )
    value = json.loads(request.to_json())
    assert value["network_profile"] == "egress"
    assert value["egress_expires_at"] > time.time()


def test_sandboxd_rejects_non_finite_egress_expiry():
    from agent.sandbox.protocol import ExecuteRequest
    import pytest

    with pytest.raises(ValueError, match="egress 授权已过期"):
        ExecuteRequest.from_dict({
            "root": "/data/user/shell",
            "command": "curl https://example.com",
            "network_profile": "egress",
            "egress_expires_at": "Infinity",
        })


def test_docker_execution_uses_unique_container_name_for_cleanup(tmp_path):
    from agent.sandbox.docker import DockerSandboxExecutor

    settings = SimpleNamespace(
        image="debian:bookworm-slim",
        image_digest="sha256:" + "a" * 64,
        network_profile="none",
        pids_limit=64,
        cpu_limit=1,
        memory_limit_bytes=128 * 1024 * 1024,
        ephemeral_quota_bytes=128 * 1024 * 1024,
        egress_proxy_url="",
        egress_isolation_enabled=False,
    )
    executor = DockerSandboxExecutor(tmp_path, settings, docker_path="/usr/bin/docker")
    argv = executor.build_argv("pwd", container_name="gugu-sandbox-test")
    assert "--name=gugu-sandbox-test" in argv


def test_sandboxd_server_rejects_root_outside_allowed_root(tmp_path):
    from agent.sandbox.sandboxd import SandboxdServer
    import pytest

    allowed = tmp_path / "allowed"
    allowed.mkdir()
    other = tmp_path / "other"
    other.mkdir()
    server = SandboxdServer(tmp_path / "sandboxd.sock", allowed)
    with pytest.raises(ValueError, match="允许的用户数据目录"):
        server._validate_root(str(other))


def test_cleanup_orphan_pty_containers_only_uses_fixed_namespace(monkeypatch):
    from agent.sandbox import docker_runtime

    calls = []
    monkeypatch.setattr(docker_runtime.shutil, "which", lambda name: "/usr/bin/docker")

    class Result:
        returncode = 0
        stdout = "a" * 12 + "\n" + "not-a-container\n"

    def run(argv, **kwargs):
        calls.append(argv)
        return Result()

    monkeypatch.setattr(docker_runtime.subprocess, "run", run)
    assert docker_runtime.cleanup_orphan_pty_containers() == 1
    assert calls[0] == ["/usr/bin/docker", "ps", "-aq", "--filter", "name=^gugu-pty-"]
    assert calls[1] == ["/usr/bin/docker", "rm", "-f", "a" * 12]


def test_sandbox_override_includes_sandboxd_socket(monkeypatch, tmp_path):
    from app.core.config import AppSettings

    override = tmp_path / "config.override.json"
    override.write_text('{"sandbox":{"sandboxd_socket":"/run/user/1000/gugu.sock"}}', encoding="utf-8")
    import app.core.config as config
    monkeypatch.setattr(config, "OVERRIDE_FILE", override)
    settings = AppSettings().apply_override()
    assert settings.sandbox.sandboxd_socket == "/run/user/1000/gugu.sock"


def test_sandbox_readiness_rejects_disabled(monkeypatch):
    settings = SimpleNamespace(enabled=False, rootless_required=True, image_digest="sha256:" + "a" * 64)
    monkeypatch.setattr(docker_runtime, "probe_docker", lambda: (_ for _ in ()).throw(AssertionError("不应探测关闭的沙盒")))
    ready, reason = docker_runtime.sandbox_readiness(settings)
    assert not ready
    assert reason == "Shell 沙盒未开启"


def test_sandbox_readiness_rejects_invalid_egress_configuration(monkeypatch):
    settings = SimpleNamespace(
        enabled=True,
        rootless_required=True,
        network_profile="egress",
        egress_proxy_url="",
        egress_isolation_enabled=True,
        egress_network_name="gugu-sandbox-egress",
    )
    monkeypatch.setattr(docker_runtime, "probe_docker", lambda: (_ for _ in ()).throw(AssertionError("不应探测 Docker")))
    ready, reason = docker_runtime.sandbox_readiness(settings)
    assert ready is False
    assert "代理未配置" in reason


def test_egress_proxy_must_be_http_without_embedded_credentials():
    assert docker_runtime.valid_egress_proxy("http://proxy.example:3128")
    assert docker_runtime.valid_egress_proxy("https://proxy.example")
    assert not docker_runtime.valid_egress_proxy("socks5://proxy.example:1080")
    assert not docker_runtime.valid_egress_proxy("http://user:secret@proxy.example:3128")


def test_admin_egress_proxy_config_rejects_credentials_and_query():
    import asyncio
    from fastapi import HTTPException
    from app.api.v1.sandbox_admin import EgressProxyConfigRequest, save_egress_proxy

    with pytest.raises(HTTPException, match="无凭据"):
        asyncio.run(save_egress_proxy(EgressProxyConfigRequest(proxy_url="http://user:secret@proxy.example:3128")))
    with pytest.raises(HTTPException, match="查询参数"):
        asyncio.run(save_egress_proxy(EgressProxyConfigRequest(proxy_url="http://proxy.example:3128/?token=1")))


def test_admin_sandbox_state_requires_loaded_image():
    from app.api.v1.sandbox_admin import _state

    runtime = docker_runtime.DockerRuntimeStatus(True, True, True)
    state, message = _state(runtime, enabled=True, rootless_required=True, image_ready=False)
    assert state == "image_unavailable"
    assert "镜像" in message


def test_admin_sandbox_state_ready_only_when_image_is_loaded():
    from app.api.v1.sandbox_admin import _state

    runtime = docker_runtime.DockerRuntimeStatus(True, True, True)
    assert _state(runtime, enabled=True, rootless_required=True, image_ready=True) == (
        "ready",
        "Docker 沙盒运行时已就绪",
    )


def test_admin_executor_readiness_is_independent_of_enabled_switch(monkeypatch):
    from app.api.v1 import sandbox_admin
    from app.core.config import SandboxSettings

    settings = SandboxSettings(enabled=False)
    monkeypatch.setattr(sandbox_admin, "get_settings", lambda: SimpleNamespace(sandbox=settings))
    monkeypatch.setattr(
        sandbox_admin,
        "probe_docker",
        lambda: docker_runtime.DockerRuntimeStatus(True, True, True),
    )
    monkeypatch.setattr(sandbox_admin, "valid_image_digest", lambda value: True)
    monkeypatch.setattr(sandbox_admin, "image_available", lambda *_args, **_kwargs: True)
    response = sandbox_admin._response()
    assert response["state"] == "disabled"
    assert response["executor_ready"] is True


def test_admin_sandbox_status_does_not_echo_invalid_proxy(monkeypatch):
    from app.api.v1 import sandbox_admin
    from app.core.config import SandboxSettings

    settings = SandboxSettings(
        enabled=False,
        egress_proxy_url="http://user:secret@proxy.example:3128",
        egress_isolation_enabled=True,
    )
    monkeypatch.setattr(sandbox_admin, "get_settings", lambda: SimpleNamespace(sandbox=settings))
    monkeypatch.setattr(
        sandbox_admin,
        "probe_docker",
        lambda: docker_runtime.DockerRuntimeStatus(True, True, True),
    )
    monkeypatch.setattr(sandbox_admin, "valid_image_digest", lambda value: True)
    monkeypatch.setattr(sandbox_admin, "image_available", lambda *_args, **_kwargs: True)

    response = sandbox_admin._response()
    assert response["egress_proxy_url"] == ""
    assert response["egress_available"] is False
    assert "无凭据" in response["egress_config_error"]


def test_docker_executor_builds_fixed_security_argv(tmp_path):
    from agent.sandbox.docker import DockerSandboxExecutor

    settings = SimpleNamespace(
        image="debian:bookworm-slim",
        image_digest="sha256:" + "b" * 64,
        network_profile="none",
        pids_limit=64,
        cpu_limit=1.0,
        memory_limit_bytes=512 * 1024 * 1024,
        timeout_seconds=30,
        output_limit_bytes=12_000,
    )
    executor = DockerSandboxExecutor(tmp_path, settings, docker_path="/usr/bin/docker")
    argv = executor.build_argv("pwd", cwd=".")
    assert argv[0:4] == ["/usr/bin/docker", "run", "--rm", "--init"]
    assert "--pull=never" in argv
    assert "--label=com.gugu.sandbox=true" in argv
    assert any(item.startswith("--label=com.gugu.sandbox.root-id=") for item in argv)
    assert "--network=none" in argv
    assert "--read-only" in argv
    assert "--cap-drop=ALL" in argv
    assert "--security-opt=no-new-privileges" in argv
    assert not any(item.startswith("--security-opt=seccomp=") for item in argv)
    assert "--security-opt=apparmor=docker-default" in argv
    assert "--user=65532:65532" in argv
    assert any(item.startswith("--mount=type=bind,") and ",dst=/workspace" in item for item in argv)
    assert not any("privileged" in item or "host" in item or "docker.sock" in item for item in argv)
    assert argv[-2] == "debian:bookworm-slim@sha256:" + "b" * 64
    assert argv[-1] == "pwd"


def test_docker_executor_uses_only_controlled_egress_network(tmp_path):
    from agent.sandbox.docker import DockerSandboxExecutor

    settings = SimpleNamespace(
        image="debian:bookworm-slim",
        image_digest="sha256:" + "d" * 64,
        network_profile="egress",
        egress_proxy_url="http://egress-proxy:3128",
        egress_isolation_enabled=True,
        egress_network_name="gugu-sandbox-egress",
        pids_limit=64,
        cpu_limit=1.0,
        memory_limit_bytes=512 * 1024 * 1024,
        timeout_seconds=30,
        output_limit_bytes=12_000,
    )
    argv = DockerSandboxExecutor(tmp_path, settings, docker_path="/usr/bin/docker").build_argv(
        "curl https://example.com", network_profile="egress"
    )
    assert "--network=gugu-sandbox-egress" in argv
    assert "--env=HTTP_PROXY=http://egress-proxy:3128" in argv
    assert "--env=HTTPS_PROXY=http://egress-proxy:3128" in argv
    assert "--env=NO_PROXY=127.0.0.1,localhost" in argv
    assert "--network=none" not in argv


def test_docker_executor_builds_fixed_interactive_pty_argv(tmp_path):
    from agent.sandbox.docker import DockerSandboxExecutor

    settings = SimpleNamespace(
        image="debian:bookworm-slim",
        image_digest="sha256:" + "e" * 64,
        network_profile="none",
        pids_limit=64,
        cpu_limit=1.0,
        memory_limit_bytes=512 * 1024 * 1024,
        ephemeral_quota_bytes=64 * 1024 * 1024,
        timeout_seconds=30,
        output_limit_bytes=12_000,
    )
    argv = DockerSandboxExecutor(tmp_path, settings, docker_path="/usr/bin/docker").build_pty_argv(
        cwd=".", container_name="gugu-pty-test",
    )

    assert argv[1:5] == ["run", "--interactive", "--tty", "--rm"]
    assert argv[-4].startswith("debian:bookworm-slim@sha256:")
    assert argv[-3:] == ["bash", "--noprofile", "--norc"]
    assert r"--env=PS1=gugu-sandbox:\w\$ " in argv
    assert "--cap-drop=ALL" in argv
    assert "--security-opt=no-new-privileges" in argv
    assert "--network=none" in argv


def test_docker_executor_uses_one_image_reference_for_command_and_pty(tmp_path):
    from agent.sandbox.docker import DockerSandboxExecutor

    settings = SimpleNamespace(
        image="gugu-sandbox:bookworm-dev",
        image_digest="sha256:" + "d" * 64,
        network_profile="none",
        pids_limit=64,
        cpu_limit=1.0,
        memory_limit_bytes=512 * 1024 * 1024,
        ephemeral_quota_bytes=64 * 1024 * 1024,
        timeout_seconds=30,
        output_limit_bytes=12_000,
    )
    executor = DockerSandboxExecutor(tmp_path, settings, docker_path="/usr/bin/docker")
    command_argv = executor.build_argv("printf hello", cwd=".", container_name="gugu-sandbox-test")
    pty_argv = executor.build_pty_argv(cwd=".", container_name="gugu-pty-test")

    command_image = next(value for value in command_argv if value.startswith("gugu-sandbox:bookworm-dev@"))
    pty_image = next(value for value in pty_argv if value.startswith("gugu-sandbox:bookworm-dev@"))
    assert command_image == pty_image


def test_docker_executor_rejects_unpinned_image(tmp_path):
    from agent.sandbox.docker import DockerSandboxExecutor

    settings = SimpleNamespace(
        image="debian:bookworm-slim",
        image_digest="latest",
        network_profile="none",
        pids_limit=64,
        cpu_limit=1.0,
        memory_limit_bytes=512 * 1024 * 1024,
        timeout_seconds=30,
        output_limit_bytes=12_000,
    )
    import pytest
    with pytest.raises(ValueError, match="sha256"):
        DockerSandboxExecutor(tmp_path, settings, docker_path="/usr/bin/docker")


def test_docker_executor_rejects_egress_with_invalid_network_name(tmp_path):
    from agent.sandbox.docker import DockerSandboxExecutor

    settings = SimpleNamespace(
        image="debian:bookworm-slim",
        image_digest="sha256:" + "b" * 64,
        network_profile="none",
        egress_proxy_url="http://proxy.example:3128",
        egress_isolation_enabled=True,
        egress_network_name="bad network",
        pids_limit=64,
        cpu_limit=1.0,
        memory_limit_bytes=512 * 1024 * 1024,
        ephemeral_quota_bytes=1024 * 1024 * 1024,
        timeout_seconds=30,
        output_limit_bytes=12_000,
    )
    import pytest
    with pytest.raises(ValueError, match="egress 网络名无效"):
        DockerSandboxExecutor(tmp_path, settings, docker_path="docker").build_argv(
            "curl https://example.com", network_profile="egress"
        )


def test_docker_executor_applies_ephemeral_quota_to_tmpfs(tmp_path):
    from agent.sandbox.docker import DockerSandboxExecutor

    settings = SimpleNamespace(
        image="debian:bookworm-slim",
        image_digest="sha256:" + "c" * 64,
        network_profile="none",
        pids_limit=64,
        cpu_limit=1.0,
        memory_limit_bytes=512 * 1024 * 1024,
        ephemeral_quota_bytes=1024 * 1024 * 1024,
        timeout_seconds=30,
        output_limit_bytes=12_000,
    )
    argv = DockerSandboxExecutor(tmp_path, settings, docker_path="/usr/bin/docker").build_argv("pwd")
    assert "--tmpfs=/tmp:rw,noexec,nosuid,size=1073741824" in argv


def test_parse_subordinate_ranges_ignores_other_users():
    from agent.sandbox.rootless_permissions import parse_subordinate_ranges

    ranges = parse_subordinate_ranges(
        "# comment\nother:200000:65536\nrunner:100000:65536\nrunner:200000:65536\n",
        "runner",
    )
    assert [(item.start, item.count) for item in ranges] == [(100000, 65536), (200000, 65536)]


def test_permission_plan_maps_container_id_and_is_non_destructive(tmp_path):
    from agent.sandbox.rootless_permissions import SubordinateRange, build_permission_plan

    plan = build_permission_plan(
        tmp_path / "workspace",
        login="runner",
        subuid=(SubordinateRange("runner", 100000, 65536),),
        subgid=(SubordinateRange("runner", 100000, 65536),),
    )
    assert plan.mapped_uid == 165531
    assert plan.mapped_gid == 165531
    assert not plan.root.exists()
    assert plan.commands[0][:4] == ("install", "-d", "-o", "runner")
    assert any("g:165531:rwx" in part for part in plan.commands[1])
    assert any("g:165531:rwX" in part for part in plan.commands[3])


def test_permission_plan_rejects_root_directory(tmp_path):
    from agent.sandbox.rootless_permissions import SubordinateRange, build_permission_plan
    import pytest

    mapping = (SubordinateRange("runner", 100000, 65536),)
    with pytest.raises(ValueError, match="非根绝对路径"):
        build_permission_plan(
            "/",
            login="runner",
            subuid=mapping,
            subgid=mapping,
        )


def test_discover_shell_roots_only_scans_user_directories(tmp_path):
    from scripts.prepare_rootless_users import discover_shell_roots

    (tmp_path / "user-a").mkdir()
    (tmp_path / "user-b").mkdir()
    (tmp_path / ".staging").mkdir()
    (tmp_path / "not-a-user.txt").write_text("ignored", encoding="utf-8")
    assert discover_shell_roots(tmp_path) == (tmp_path / "user-a" / "shell", tmp_path / "user-b" / "shell")


def test_systemd_templates_pin_rootless_socket():
    from pathlib import Path

    backend = Path(__file__).parents[1]
    for name in ("gugu-backend.service", "gugu-worker.service", "gugu-supervisor.service"):
        text = (backend / name).read_text(encoding="utf-8")
        assert 'DOCKER_HOST=unix:///run/user/__RUN_UID__/docker.sock' in text
        assert 'GUGU_SANDBOXD_SOCKET=/run/user/__RUN_UID__/gugu-sandboxd.sock' in text
    start_script = (backend / "start.sh").read_text(encoding="utf-8")
    assert 'id -u "$run_user"' in start_script
    assert 's#__RUN_UID__#${run_uid}#g' in start_script
    sandboxd = (backend / "gugu-sandboxd.service").read_text(encoding="utf-8")
    assert "agent.sandbox.sandboxd" in sandboxd
    assert "--allowed-root __DATA_DIR__" in sandboxd


def test_quota_measurement_ignores_symlinks_and_checks_reservation(tmp_path):
    from agent.sandbox.quota import SandboxQuotaSnapshot, can_reserve, measure_directory, snapshot_quota

    (tmp_path / "a.txt").write_bytes(b"1234")
    outside = tmp_path.parent / "quota-outside.txt"
    outside.write_bytes(b"outside")
    (tmp_path / "link").symlink_to(outside)
    assert measure_directory(tmp_path) == 4
    snapshot = snapshot_quota(tmp_path, 8)
    assert snapshot == SandboxQuotaSnapshot(4, 8)
    assert can_reserve(snapshot, 4)
    assert not can_reserve(snapshot, 5)
    assert snapshot_quota(tmp_path, 3).exceeded
    outside.unlink()


def test_sandbox_root_initializer_only_creates_shell_directory(tmp_path):
    from agent.sandbox.quota import ensure_sandbox_root

    root = ensure_sandbox_root(tmp_path / "user-1" / "shell")
    assert root.is_dir()
    with pytest.raises(ValueError):
        ensure_sandbox_root(tmp_path / "user-1" / "uploads")


def test_clear_sandbox_directory_keeps_root_and_removes_contents(tmp_path):
    from agent.sandbox.quota import clear_sandbox_directory

    root = tmp_path / "users" / "user-a" / "shell"
    root.mkdir(parents=True)
    (root / "note.txt").write_text("x", encoding="utf-8")
    (root / "build").mkdir()
    (root / "build" / "out").write_text("x", encoding="utf-8")
    assert clear_sandbox_directory(root) == 2
    assert root.is_dir()
    assert tuple(root.iterdir()) == ()
