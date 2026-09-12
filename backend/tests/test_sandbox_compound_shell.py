"""沙盒复合命令支持：含 shell 元字符的命令整体交给容器内 /bin/sh -c 解释。

安全边界不变：风险分类在 shell_policy 按整条命令串完成；重定向与命令替换
归类 dangerous 走确认门；普通模式（未开直跑/未授权脚本）仍禁止代码运行时，
检查对象换成 -c 载荷的内层 token；逐参数路径预检对载荷不透明，跳过后由
容器 OS 边界兜底。
"""
from __future__ import annotations

from types import SimpleNamespace


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        image="debian:bookworm-slim", image_digest="sha256:" + "a" * 64,
        network_profile="none", pids_limit=64, cpu_limit=1,
        memory_limit_bytes=128 * 1024 * 1024, ephemeral_quota_bytes=128 * 1024 * 1024,
        egress_proxy_url="", egress_isolation_enabled=False,
    )


def _executor(tmp_path):
    from agent.sandbox.docker import DockerSandboxExecutor

    return DockerSandboxExecutor(tmp_path, _settings(), docker_path="/usr/bin/docker")


def _container_tail(argv: list[str]) -> list[str]:
    """docker run 参数里镜像名之后的容器内 argv。"""
    image_index = next(index for index, value in enumerate(argv) if value.startswith("debian:"))
    return argv[image_index + 1:]


def test_compound_command_wraps_into_sh_c(tmp_path):
    """含元字符的复合命令整体交给 /bin/sh -c，而不是按 argv 直跑。"""
    argv = _executor(tmp_path).build_argv("echo a && echo b")
    tail = _container_tail(argv)
    assert tail == ["/bin/sh", "-c", "echo a && echo b"]


def test_compound_command_with_pipes_and_semicolons(tmp_path):
    argv = _executor(tmp_path).build_argv("cd sub; cat a.txt | wc -l")
    assert _container_tail(argv) == ["/bin/sh", "-c", "cd sub; cat a.txt | wc -l"]


def test_compound_command_allows_dotdot_without_false_path_rejection(tmp_path):
    """-c 载荷不再走逐参数路径预检：`cd ..` 不能被误判为路径越界。"""
    (tmp_path / "sub").mkdir()
    argv = _executor(tmp_path).build_argv("cd .. && ls", cwd="sub")
    assert _container_tail(argv) == ["/bin/sh", "-c", "cd .. && ls"]


def test_compound_command_blocks_runtime_in_normal_mode(tmp_path):
    """普通模式下 -c 载荷内层 token 仍禁代码运行时，防止 && 绕过运行时门。"""
    import pytest

    with pytest.raises(ValueError, match="运行时"):
        _executor(tmp_path).build_argv("echo x && python3 tool.py")
    with pytest.raises(ValueError, match="运行时"):
        _executor(tmp_path).build_argv("mkdir d && bash d/setup.sh")


def test_compound_command_allows_runtime_with_script_authorization(tmp_path):
    """直跑/脚本授权模式下复合命令内的运行时随直跑语义放行。"""
    argv = _executor(tmp_path).build_argv(
        "cd app && python3 main.py", allow_script_execution=True,
    )
    assert _container_tail(argv) == ["/bin/sh", "-c", "cd app && python3 main.py"]


def test_plain_command_still_runs_direct_argv(tmp_path):
    """无元字符命令维持 argv 直跑，不被 sh -c 包装。"""
    argv = _executor(tmp_path).build_argv("ls -la")
    assert _container_tail(argv) == ["ls", "-la"]


def test_plain_curl_allows_container_device_output(tmp_path):
    """Docker 沙盒允许 curl 使用容器内安全设备路径，不误报 workspace 越界。"""
    argv = _executor(tmp_path).build_argv(
        "curl -s -o /dev/null -w 'baidu: %{http_code}' https://www.baidu.com --max-time 8",
    )
    assert _container_tail(argv) == [
        "curl", "-s", "-o", "/dev/null", "-w", "baidu: %{http_code}",
        "https://www.baidu.com", "--max-time", "8",
    ]


def test_plain_docker_command_still_rejects_external_absolute_paths(tmp_path):
    """放行容器设备路径不应扩大到宿主机绝对路径。"""
    import pytest

    with pytest.raises(ValueError, match="绝对路径"):
        _executor(tmp_path).build_argv("curl -o /etc/passwd https://www.baidu.com")


def test_compound_command_rejects_invalid_quotes(tmp_path):
    """普通模式下 -c 载荷引号解析失败时明确报错，不静默交给 sh。"""
    import pytest

    with pytest.raises(ValueError, match="引号格式无效"):
        _executor(tmp_path).build_argv("echo 'unterminated && ls")


def test_has_shell_meta_scan_is_raw_text():
    """元字符扫描按原始串判断，不解析引号（宁滥勿缺：sh 会正确处理引号）。"""
    from agent.sandbox.local_executor import LocalWorkspaceExecutor

    assert LocalWorkspaceExecutor._has_shell_meta("echo a && echo b") is True
    assert LocalWorkspaceExecutor._has_shell_meta('grep "a|b" file') is True
    assert LocalWorkspaceExecutor._has_shell_meta("ls -la") is False
    assert LocalWorkspaceExecutor._has_shell_meta("") is False
