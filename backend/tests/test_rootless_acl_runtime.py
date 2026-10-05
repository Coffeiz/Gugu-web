"""运行时沙盒 ACL 初始化（ensure_sandbox_acl）的降级与幂等行为。

真实 setfacl / /etc/subuid 依赖宿主环境，测试统一打桩：只验证分支选择、
进程内幂等缓存和 chmod 兜底不被 ACL 路径覆盖。
"""
from __future__ import annotations

import os
import pwd
import stat
from pathlib import Path

import pytest

from agent.sandbox import rootless_permissions
from agent.sandbox.rootless_permissions import SubordinateRange, ensure_sandbox_acl


@pytest.fixture()
def reset_acl_caches(monkeypatch):
    monkeypatch.setattr(rootless_permissions, "_acl_ready_roots", set())
    monkeypatch.setattr(rootless_permissions, "_acl_warned_roots", set())


@pytest.fixture()
def fake_rootless(monkeypatch, reset_acl_caches):
    """伪造可用的 rootless 环境：setfacl 存在 + subordinate 映射齐全。"""
    applied: list[rootless_permissions.WorkspacePermissionPlan] = []
    monkeypatch.setattr(rootless_permissions.shutil, "which", lambda name: "/usr/bin/setfacl")
    ranges = (SubordinateRange("tester", 100000, 65536),)
    monkeypatch.setattr(rootless_permissions, "read_subordinate_ranges", lambda path, login: ranges)
    monkeypatch.setattr(rootless_permissions, "apply_permission_plan", applied.append)
    return applied


def test_ensure_sandbox_acl_applies_plan_once(tmp_path: Path, fake_rootless):
    root = tmp_path / "workspace"
    root.mkdir()
    assert ensure_sandbox_acl(root) is True
    assert ensure_sandbox_acl(root) is True
    # 第二次命中进程内缓存，不重复递归 setfacl
    assert len(fake_rootless) == 1
    plan = fake_rootless[0]
    assert plan.root == root.resolve()
    assert plan.host_user == pwd.getpwuid(os.getuid()).pw_name


def test_ensure_sandbox_acl_uses_bootstrap_rootful_mapping(tmp_path: Path, monkeypatch, reset_acl_caches):
    root = tmp_path / "workspace"
    root.mkdir()
    applied = []
    monkeypatch.setattr(rootless_permissions.shutil, "which", lambda name: "/usr/bin/setfacl")
    monkeypatch.setattr(rootless_permissions, "_read_runtime_identity", lambda: (65532, 65532))
    monkeypatch.setattr(
        rootless_permissions,
        "read_subordinate_ranges",
        lambda *_args: (_ for _ in ()).throw(AssertionError("rootful mapping must not read subordinate IDs")),
    )
    monkeypatch.setattr(rootless_permissions, "apply_permission_plan", applied.append)

    assert ensure_sandbox_acl(root) is True
    assert len(applied) == 1
    assert applied[0].mapped_uid == 65532
    assert applied[0].mapped_gid == 65532


def test_embedded_rootless_acl_allows_daemon_to_traverse_data_without_recursive_data_acl(
    tmp_path: Path, monkeypatch, reset_acl_caches,
):
    data_root = tmp_path / "data"
    users_root = data_root / "users"
    workspace = users_root / "synthetic-user" / "shell"
    workspace.mkdir(parents=True)
    applied = []
    monkeypatch.setenv("GUGU_SANDBOX_MANAGER_MODE", "embedded")
    monkeypatch.setenv("GUGU_DATA_DIR", str(data_root))
    monkeypatch.setenv("GUGU_ROOTLESS_UID", "1000")
    monkeypatch.setattr(rootless_permissions.shutil, "which", lambda name: "/usr/bin/setfacl")
    monkeypatch.setattr(rootless_permissions, "_read_runtime_identity", lambda: (165531, 165531))
    monkeypatch.setattr(rootless_permissions, "apply_permission_plan", lambda plan: None)
    monkeypatch.setattr(
        rootless_permissions.subprocess, "run",
        lambda command, **kwargs: applied.append(command),
    )

    assert ensure_sandbox_acl(workspace) is True
    acl_targets = [Path(command[-1]) for command in applied]
    assert acl_targets == [workspace, workspace.parent, users_root, data_root]
    assert applied[-1] == ("setfacl", "-m", "u:1000:--x", str(data_root))


def test_runtime_identity_reads_and_validates_bootstrap_file(tmp_path: Path, monkeypatch):
    identity_file = tmp_path / "sandbox-storage-identity.json"
    monkeypatch.setattr(rootless_permissions, "_RUNTIME_IDENTITY_PATH", identity_file)
    identity_file.write_text(
        '{"schema":1,"daemon_mode":"rootful","container_uid":65532,'
        '"container_gid":65532,"mapped_uid":65532,"mapped_gid":65532}',
        encoding="utf-8",
    )
    assert rootless_permissions._read_runtime_identity() == (65532, 65532)

    identity_file.write_text('{"schema":1,"daemon_mode":"rootless"}', encoding="utf-8")
    with pytest.raises(ValueError, match="UID/GID"):
        rootless_permissions._read_runtime_identity()


def test_ensure_sandbox_acl_degrades_without_setfacl(tmp_path: Path, monkeypatch, reset_acl_caches):
    monkeypatch.setattr(rootless_permissions.shutil, "which", lambda name: None)
    root = tmp_path / "workspace"
    root.mkdir()
    assert ensure_sandbox_acl(root) is False


def test_ensure_sandbox_acl_degrades_without_subordinate_mapping(tmp_path: Path, monkeypatch, reset_acl_caches):
    monkeypatch.setattr(rootless_permissions.shutil, "which", lambda name: "/usr/bin/setfacl")

    def raise_missing(path, login):
        raise ValueError("无 subordinate 映射")

    monkeypatch.setattr(rootless_permissions, "read_subordinate_ranges", raise_missing)
    root = tmp_path / "workspace"
    root.mkdir()
    assert ensure_sandbox_acl(root) is False


def test_prepare_workspace_root_falls_back_to_chmod(tmp_path: Path, monkeypatch, reset_acl_caches):
    from app.services.workspaces import _prepare_workspace_root

    monkeypatch.setattr(rootless_permissions.shutil, "which", lambda name: None)
    root = tmp_path / "user-1" / "QQ"
    _prepare_workspace_root(root)
    assert root.is_dir()
    assert stat.S_IMODE(root.stat().st_mode) == 0o777


def test_prepare_workspace_root_prefers_acl_over_chmod(tmp_path: Path, fake_rootless):
    from app.services.workspaces import _prepare_workspace_root

    root = tmp_path / "user-1" / "QQ"
    _prepare_workspace_root(root)
    assert root.is_dir()
    # ACL 路径直接返回，不再追加 0777 兜底 chmod
    assert len(fake_rootless) == 1
    assert fake_rootless[0].root == root.resolve()


def test_build_permission_plan_non_root_replaces_chown_with_chmod(tmp_path: Path):
    """非 root 运行时 chgrp 到映射组会 EPERM，头命令必须退化为 chmod。"""
    ranges = (SubordinateRange("tester", 100000, 65536),)
    plan = rootless_permissions.build_permission_plan(
        tmp_path / "workspace", login="tester", subuid=ranges, subgid=ranges,
        apply_ownership=False,
    )
    assert plan.commands[0] == ("chmod", "0770", str(tmp_path / "workspace"))
    assert all(command[0] != "install" for command in plan.commands)

    root_plan = rootless_permissions.build_permission_plan(
        tmp_path / "workspace", login="tester", subuid=ranges, subgid=ranges,
    )
    assert root_plan.commands[0][0] == "install"


def test_acl_initialization_skips_symlinks_to_outside_targets(tmp_path: Path, monkeypatch):
    """递归 ACL 不能跟随 workspace 符号链接去修改根目录外的目标。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    regular_file = workspace / "notes.txt"
    regular_file.write_text("test", encoding="utf-8")
    symlink_target = tmp_path / "protected-python"
    symlink_target.write_text("not an executable", encoding="utf-8")
    workspace_link = workspace / "python"
    workspace_link.symlink_to(symlink_target)

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_setfacl = fake_bin / "setfacl"
    fake_setfacl.write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$ACL_CAPTURE\"\n",
        encoding="utf-8",
    )
    fake_setfacl.chmod(0o755)
    captured_args = tmp_path / "setfacl-args.txt"
    monkeypatch.setenv("PATH", f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("ACL_CAPTURE", str(captured_args))
    monkeypatch.setattr(rootless_permissions.shutil, "which", lambda name: str(fake_setfacl))

    plan = rootless_permissions.build_permission_plan(
        workspace,
        login=pwd.getpwuid(os.getuid()).pw_name,
        subuid=(),
        subgid=(),
        mapped_uid=165531,
        mapped_gid=165531,
        apply_ownership=False,
    )
    rootless_permissions.apply_permission_plan(plan)

    applied_paths = captured_args.read_text(encoding="utf-8").splitlines()
    assert str(regular_file) in applied_paths
    assert str(workspace_link) not in applied_paths
    assert str(symlink_target) not in applied_paths
