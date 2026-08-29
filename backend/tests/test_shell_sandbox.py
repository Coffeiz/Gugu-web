import asyncio

import pytest

from agent.sandbox import LocalWorkspaceExecutor


def test_local_sandbox_rejects_shell_operators(tmp_path):
    sandbox = LocalWorkspaceExecutor(tmp_path)
    with pytest.raises(ValueError):
        asyncio.run(sandbox.execute("pwd && echo escaped"))


@pytest.mark.parametrize(
    "command, filename",
    [
        ("bash payload.sh", "payload.sh"),
        ("sh payload.sh", "payload.sh"),
        ("perl payload.pl", "payload.pl"),
        ("awk -f payload.awk", "payload.awk"),
        ("sed -f payload.sed", "payload.sed"),
        ("env bash payload.sh", "payload.sh"),
        ("xargs -a payload.txt bash", "payload.txt"),
    ],
)
def test_local_sandbox_rejects_workspace_files_as_interpreter_input(tmp_path, command, filename):
    (tmp_path / filename).write_text("$(id)\n", encoding="utf-8")
    sandbox = LocalWorkspaceExecutor(tmp_path)
    with pytest.raises(ValueError, match="解释器"):
        asyncio.run(sandbox.execute(command))


def test_local_sandbox_rejects_interpreter_eval_mode(tmp_path):
    sandbox = LocalWorkspaceExecutor(tmp_path)
    with pytest.raises(ValueError, match="inline/eval"):
        asyncio.run(sandbox.execute("bash -c 'source payload.sh'"))


def test_local_sandbox_still_allows_reading_workspace_files_without_interpreter(tmp_path):
    (tmp_path / "payload.txt").write_text("$(id)\n", encoding="utf-8")
    sandbox = LocalWorkspaceExecutor(tmp_path)
    result = asyncio.run(sandbox.execute("cat payload.txt"))
    assert result.ok
    assert result.stdout == "$(id)\n"


def test_system_executor_can_run_workspace_script_inputs_without_sandbox_restriction(tmp_path):
    (tmp_path / "build.py").write_text("print('ok')\n", encoding="utf-8")
    executor = LocalWorkspaceExecutor(tmp_path, restrict_interpreter_inputs=False)
    # 只验证 system scope 的边界开关，不执行脚本，避免测试产生副作用。
    executor._validate_workspace_argv(["python", "build.py"], tmp_path)


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
