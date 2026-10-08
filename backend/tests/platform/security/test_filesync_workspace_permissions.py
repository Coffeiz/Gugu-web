"""文件同步私有目录访问必须限定在授权工作区和 Rootless 映射内。"""
from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest


def test_acl_helper_only_mounts_authorized_root_and_uses_dynamic_rootless_identity(tmp_path, monkeypatch):
    from agent.sandbox.docker import DockerSandboxExecutor

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    executor = object.__new__(DockerSandboxExecutor)
    executor.docker_path = "/usr/bin/docker"
    executor.image = "sandbox:test"
    executor.root = workspace
    def mount_source(_path, *, initialize_acl):
        assert initialize_acl is False
        return Path("/host/authorized-workspace")

    monkeypatch.setattr(executor, "_daemon_mount_src_for", mount_source)

    argv = executor.build_filesync_acl_argv(workspace)
    command = argv[-1]

    assert "--network=none" in argv
    assert "--read-only" in argv
    assert "--cap-drop=ALL" in argv
    assert "--user=65532:65532" in argv
    assert any("src=/host/authorized-workspace,dst=/workspace" in arg for arg in argv)
    assert "u:0:rwx" in command and "d:u:0:rwx" in command
    assert "u:0:rwX" in command
    # ACL 目标是 Rootless namespace 中映射到 daemon 登录用户的 UID 0，
    # 不依赖某个安装环境的宿主 UID/GID 常量。
    assert "165531" not in command and "1000" not in command


@pytest.mark.parametrize(
    ("find_error", "expected_returncode"),
    [
        ("find: ‘/workspace/.private’: Permission denied", 1),
        ("setfacl: ‘/workspace/file’: Permission denied", 1),
        ("find: unexpected traversal failure", 1),
    ],
)
def test_acl_helper_preserves_traversal_and_acl_failures(
    tmp_path, monkeypatch, find_error, expected_returncode,
):
    from agent.sandbox.docker import DockerSandboxExecutor

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    executor = object.__new__(DockerSandboxExecutor)
    executor.docker_path = "/usr/bin/docker"
    executor.image = "sandbox:test"
    executor.root = workspace
    monkeypatch.setattr(
        executor, "_daemon_mount_src_for",
        lambda _path, *, initialize_acl: Path("/host/authorized-workspace"),
    )
    command = executor.build_filesync_acl_argv(workspace)[-1]
    fake_find = 'find() { printf "%s\\n" "$FAKE_FIND_ERROR" >&2; return 1; }\n'
    result = subprocess.run(
        ["bash", "-c", fake_find + command],
        env={**os.environ, "FAKE_FIND_ERROR": find_error},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == expected_returncode


def test_filesync_mount_resolution_does_not_run_general_acl_walk(tmp_path, monkeypatch):
    from agent.sandbox import rootless_permissions
    from agent.sandbox.docker import DockerSandboxExecutor

    users_root = tmp_path / "users"
    workspace = users_root / str(uuid.uuid4()) / "workspace" / "default"
    workspace.mkdir(parents=True)
    executor = object.__new__(DockerSandboxExecutor)
    executor.settings = SimpleNamespace(manager_mode="embedded")
    monkeypatch.setattr("app.core.config.get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(local_path=str(users_root)),
    ))

    def forbidden_acl_walk(_root):
        raise AssertionError("文件同步权限助手不应先执行普通 ACL 递归扫描")

    monkeypatch.setattr(rootless_permissions, "ensure_sandbox_acl", forbidden_acl_walk)

    assert executor._daemon_mount_src_for(workspace, initialize_acl=False) == workspace.resolve()


def test_root_worker_repairs_acl_through_sandbox_owner_container(tmp_path, monkeypatch):
    from agent.sandbox.docker import DockerSandboxExecutor

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    executor = object.__new__(DockerSandboxExecutor)
    executor.root = workspace
    executor.docker_path = "/usr/bin/docker"
    executor.image = "sandbox:test"
    monkeypatch.setattr(
        executor, "_daemon_mount_src_for",
        lambda path, *, initialize_acl: Path("/host/authorized-workspace"),
    )
    calls = []

    class Result:
        returncode = 0

    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setattr(
        "agent.sandbox.docker.subprocess.run",
        lambda command, **_kwargs: calls.append(command) or Result(),
    )

    executor.prepare_filesync_access(workspace)

    assert len(calls) == 1
    assert calls[0][0:3] == ["/usr/bin/docker", "run", "--rm"]
    assert "--user=65532:65532" in calls[0]
    assert "setfacl" in calls[0][-1]


def test_non_root_worker_refuses_rootless_acl_when_daemon_owner_differs(monkeypatch):
    from agent.sandbox.docker import DockerSandboxExecutor

    monkeypatch.setattr("agent.sandbox.docker.os.geteuid", lambda: 4242)
    monkeypatch.setattr("agent.sandbox.docker.os.getuid", lambda: 4242)
    monkeypatch.setattr("agent.sandbox.docker.docker_environment", lambda: {
        "DOCKER_HOST": "unix:///tmp/rootless-docker.sock",
    })
    monkeypatch.setattr(Path, "stat", lambda _path: SimpleNamespace(st_uid=1000))

    with pytest.raises(RuntimeError, match="用户不一致"):
        DockerSandboxExecutor._ensure_filesync_worker_matches_rootless_daemon()


@pytest.mark.asyncio
async def test_sandboxd_acl_helper_accepts_only_roots_inside_one_uuid_user_directory(monkeypatch, tmp_path):
    from agent.sandbox import sandboxd

    users_root = tmp_path / "users"
    user_id = str(uuid.uuid4())
    workspace = users_root / user_id / "workspace" / "default"
    workspace.mkdir(parents=True)
    settings = SimpleNamespace(
        storage=SimpleNamespace(local_path=str(users_root)),
        sandbox=SimpleNamespace(),
    )
    monkeypatch.setattr(sandboxd, "get_settings", lambda: settings)

    prepared: list[Path] = []

    class FakeExecutor:
        def __init__(self, root, _settings):
            self.root = Path(root)

        def prepare_filesync_access(self, root):
            prepared.append(Path(root))

    monkeypatch.setattr(sandboxd, "DockerSandboxExecutor", FakeExecutor)
    server = object.__new__(sandboxd.SandboxdServer)
    server.allowed_root = users_root.resolve()

    assert await server._prepare_filesync_access({"root": str(workspace)}) == {"ok": True}
    assert prepared == [workspace]

    user_root = users_root / user_id
    project_files = user_root / "项目文件" / "项目甲"
    project_files.mkdir(parents=True)
    assert await server._prepare_filesync_access({"root": str(user_root)}) == {"ok": True}
    assert await server._prepare_filesync_access({"root": str(project_files)}) == {"ok": True}
    assert prepared == [workspace, user_root, project_files]

    with pytest.raises(ValueError, match="用户独立数据目录"):
        await server._prepare_filesync_access({"root": str(users_root)})
    outside = tmp_path / "outside"
    outside.mkdir()
    with pytest.raises(ValueError, match="允许的用户数据目录"):
        await server._prepare_filesync_access({"root": str(outside)})
    invalid_user_root = users_root / "not-a-user-id" / "workspace"
    invalid_user_root.mkdir(parents=True)
    with pytest.raises(ValueError, match="用户目录无效"):
        await server._prepare_filesync_access({"root": str(invalid_user_root)})
    assert prepared == [workspace, user_root, project_files]
