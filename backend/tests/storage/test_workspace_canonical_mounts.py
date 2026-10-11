"""项目与文件夹 cwd 必须使用文件库规范路径，不能由工作区别名决定。"""
from types import SimpleNamespace

import pytest

from app.models import Folder, Project
from app.services import workspaces


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["project", "project_folder", "personal_folder"])
async def test_bound_library_mount_uses_canonical_path_not_display_alias(db, user_a, user_b, tmp_path, monkeypatch, kind):
    from agent.sandbox.docker import DockerSandboxExecutor
    from agent.sandbox.protocol import WorkspaceMount
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings().storage, "local_path", str(tmp_path))
    project = Project(user_id=user_a.id, name="月光项目", start_date="2026-10-01")
    db.add(project)
    await db.flush()
    folder = Folder(user_id=user_a.id, name="需求", project_id=project.id if kind == "project_folder" else None)
    db.add(folder)
    await db.flush()
    kwargs = {"kind": "project", "project_id": project.id} if kind == "project" else {"kind": "folder", "folder_id": folder.id}
    bound = await workspaces.create_workspace(db, user_a.id, name="随意的显示名", **kwargs)
    root = await workspaces.resolve_workspace_root(db, user_a.id, bound.id)
    root.mkdir(parents=True)
    target = f"/project/2026/10/月光项目 #{project.id}" if kind != "personal_folder" else "/personal/需求"
    if kind == "project_folder":
        target += "/需求"
    mounts, cwd = await workspaces.resolve_shell_workspace_mounts(db, user_a.id, bound.id, include_all=False)
    assert mounts == [(target, root)]
    assert cwd == target
    assert await workspaces.resolve_shell_workspace_mounts(db, user_b.id, bound.id, include_all=False) is None
    await workspaces.update_workspace(db, user_a.id, bound.id, name="另一个显示名")
    assert await workspaces.resolve_shell_workspace_mounts(db, user_a.id, bound.id, include_all=False) == (mounts, cwd)

    settings = SimpleNamespace(image="debian:bookworm-slim", image_digest="sha256:" + "d" * 64,
                               network_profile="none", pids_limit=64, cpu_limit=1.0,
                               memory_limit_bytes=512 * 1024 * 1024, ephemeral_quota_bytes=64 * 1024 * 1024)
    project_root = await workspaces.resolve_project_root(db, user_a.id)
    personal_root = await workspaces.resolve_user_personal_root(db, user_a.id)
    executor = DockerSandboxExecutor(root, settings, docker_path="/usr/bin/docker", project_root=project_root,
                                     personal_root=personal_root, workspace_mounts=(WorkspaceMount(target, str(root)),),
                                     primary_workspace=target)
    for argv in (executor.build_argv("pwd"), executor.build_pty_argv()):
        assert f"--workdir={target}" in argv
        assert f"--mount=type=bind,src={root},dst={target}" in argv
        assert f"--mount=type=bind,src={project_root},dst=/project,readonly" in argv
        assert f"--mount=type=bind,src={personal_root},dst=/personal,readonly" in argv
        assert not any("dst=/workspace/" in value for value in argv)
    with pytest.raises(ValueError, match="已授权"):
        executor.build_argv("pwd", cwd="/workspace/随意的显示名")
    with pytest.raises(ValueError, match="已授权"):
        executor.build_argv("pwd", cwd=target + "/../旁边目录")


@pytest.mark.parametrize("target", ["/", "/project", "//project/a", "/workspace/../project/x", "/personal/a,readonly", "/etc/a", "qq"])
def test_mount_protocol_rejects_root_alias_traversal_and_docker_option_injection(target):
    from agent.sandbox.protocol import WorkspaceMount
    with pytest.raises(ValueError):
        WorkspaceMount(target, "/synthetic/root")


@pytest.mark.parametrize("target", ["/workspace/qq", "/project/2026/10/project #7"])
def test_shell_runtime_uses_the_canonical_bound_workspace_path(tmp_path, target):
    """普通 Shell 运行时直接使用规范挂载路径，不经过脚本专用入口。"""
    from agent.sandbox.docker import DockerSandboxExecutor
    from agent.sandbox.protocol import WorkspaceMount

    settings = SimpleNamespace(
        image="debian:bookworm-slim", image_digest="sha256:" + "d" * 64,
        network_profile="none", pids_limit=64, cpu_limit=1.0,
        memory_limit_bytes=512 * 1024 * 1024, ephemeral_quota_bytes=64 * 1024 * 1024,
    )
    executor = DockerSandboxExecutor(
        tmp_path, settings, docker_path="/usr/bin/docker",
        workspace_mounts=(WorkspaceMount(target=target, root=str(tmp_path)),), primary_workspace=target,
    )
    argv = executor.build_argv("python3 check.py", cwd=target)
    image_index = next(index for index, value in enumerate(argv) if value.startswith("debian:"))
    assert f"--workdir={target}" in argv
    assert argv[image_index + 1:] == ["python3", "check.py"]
