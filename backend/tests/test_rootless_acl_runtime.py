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
