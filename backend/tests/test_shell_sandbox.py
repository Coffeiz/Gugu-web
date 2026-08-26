import asyncio

import pytest

from agent.sandbox import LocalWorkspaceExecutor


def test_local_sandbox_rejects_shell_operators(tmp_path):
    sandbox = LocalWorkspaceExecutor(tmp_path)
    with pytest.raises(ValueError):
        asyncio.run(sandbox.execute("pwd && echo escaped"))


def test_local_sandbox_runs_inside_workspace(tmp_path):
    sandbox = LocalWorkspaceExecutor(tmp_path)
    result = asyncio.run(sandbox.execute("pwd"))
    assert result.ok
    assert result.cwd == "."
    assert result.stdout.strip() == str(tmp_path.resolve())


def test_local_sandbox_returns_shell_error_for_missing_command(tmp_path):
    sandbox = LocalWorkspaceExecutor(tmp_path)
    result = asyncio.run(sandbox.execute("command-that-does-not-exist"))
    assert not result.ok
    assert result.exit_code == 127
    assert "找不到命令" in result.stderr


def test_local_sandbox_cleans_up_timeout(tmp_path):
    sandbox = LocalWorkspaceExecutor(tmp_path)
    result = asyncio.run(sandbox.execute("sleep 2", timeout=0.1))
    assert not result.ok
    assert result.timed_out


def test_local_sandbox_truncates_output_and_rejects_escape(tmp_path):
    sandbox = LocalWorkspaceExecutor(tmp_path)
    result = asyncio.run(sandbox.execute("printf 123456789", max_output_chars=4))
    assert result.stdout == "1234"
    assert result.truncated
    with pytest.raises(ValueError, match="超出 workspace"):
        asyncio.run(sandbox.execute("pwd", cwd="../"))
    with pytest.raises(ValueError, match="超出 workspace"):
        asyncio.run(sandbox.execute("ls .."))
    with pytest.raises(ValueError, match="超出 workspace"):
        asyncio.run(sandbox.execute("find ../.. -maxdepth 1"))
    with pytest.raises(ValueError, match="超出 workspace"):
        asyncio.run(sandbox.execute("ls --directory=../"))
    with pytest.raises(ValueError, match="绝对路径"):
        asyncio.run(sandbox.execute("ls /tmp"))
    with pytest.raises(ValueError, match="绝对路径"):
        asyncio.run(sandbox.execute("cat /etc/passwd"))


def test_local_sandbox_rejects_symlink_argument_escape(tmp_path):
    outside = tmp_path.parent / "shell-file-outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret", encoding="utf-8")
    link = tmp_path / "outside"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (NotImplementedError, OSError):
        pytest.skip("当前平台不支持目录软链接")
    sandbox = LocalWorkspaceExecutor(tmp_path)
    with pytest.raises(ValueError, match="超出 workspace"):
        asyncio.run(sandbox.execute("cat outside/secret.txt"))


def test_local_sandbox_rejects_windows_style_traversal(tmp_path):
    sandbox = LocalWorkspaceExecutor(tmp_path)
    with pytest.raises(ValueError, match="超出 workspace"):
        asyncio.run(sandbox.execute(r"ls ..\\..\\secret"))


def test_local_sandbox_rechecks_authorization_during_execution(tmp_path):
    sandbox = LocalWorkspaceExecutor(tmp_path)
    calls = 0

    async def authorization_check():
        nonlocal calls
        calls += 1
        return calls == 1

    result = asyncio.run(sandbox.execute("sleep 2", timeout=2, authorization_check=authorization_check))
    assert not result.ok
    assert result.permission_revoked


def test_local_sandbox_rejects_symlink_escape(tmp_path):
    outside = tmp_path.parent / "shell-outside"
    outside.mkdir()
    link = tmp_path / "outside"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (NotImplementedError, OSError):
        pytest.skip("当前平台不支持目录软链接")
    sandbox = LocalWorkspaceExecutor(tmp_path)
    with pytest.raises(ValueError, match="超出 workspace"):
        asyncio.run(sandbox.execute("pwd", cwd="outside"))


def test_local_sandbox_rejects_hardlink_to_outside_file(tmp_path):
    outside = tmp_path.parent / "shell-hardlink-outside.txt"
    outside.write_text("outside secret", encoding="utf-8")
    hardlink = tmp_path / "inside-link.txt"
    try:
        hardlink.hardlink_to(outside)
    except (NotImplementedError, OSError):
        pytest.skip("当前平台不支持硬链接")
    sandbox = LocalWorkspaceExecutor(tmp_path)
    with pytest.raises(ValueError, match="硬链接"):
        asyncio.run(sandbox.execute("cat inside-link.txt"))


def test_local_sandbox_rejects_direct_file_symlink_to_outside(tmp_path):
    outside = tmp_path.parent / "shell-file-link-outside.txt"
    outside.write_text("outside secret", encoding="utf-8")
    link = tmp_path / "inside-link.txt"
    try:
        link.symlink_to(outside)
    except (NotImplementedError, OSError):
        pytest.skip("当前平台不支持文件软链接")
    sandbox = LocalWorkspaceExecutor(tmp_path)
    with pytest.raises(ValueError, match="超出 workspace"):
        asyncio.run(sandbox.execute("cat inside-link.txt"))


def test_local_sandbox_allows_proc_word_but_not_proc_absolute_path(tmp_path):
    sandbox = LocalWorkspaceExecutor(tmp_path)
    created = asyncio.run(sandbox.execute("touch proc_test"))
    assert created.ok
    assert (tmp_path / "proc_test").is_file()
    with pytest.raises(ValueError, match="绝对路径"):
        asyncio.run(sandbox.execute("cat /proc/self/status"))
