"""Rootless Docker 沙盒执行器。

Docker 是普通用户 Shell 的真正隔离边界。本模块只接受单条 argv 命令，
并在每次执行时固定写入容器安全参数；业务参数不能覆盖网络、挂载、用户和
Linux capability 配置。
"""
from __future__ import annotations

import asyncio
import errno
import fcntl
import os
import pty
import signal
import shutil
import struct
import termios
from uuid import uuid4
from pathlib import Path
from collections.abc import Awaitable, Callable

from app.core.config import SandboxSettings

from .docker_runtime import docker_environment, sandbox_root_label, valid_egress_network_name, valid_egress_proxy, valid_image_digest
from .local_executor import LocalWorkspaceExecutor, ShellResult
from .quota import measure_directory


_MAX_TIMEOUT = 300
_MAX_OUTPUT = 120_000
_CONTAINER_ROOT = Path("/workspace")
_CONTAINER_USER = "65532:65532"


class DockerPtyHandle:
    """sandboxd 内部的 Docker PTY 句柄；不允许由 Web 进程直接构造。"""

    def __init__(self, process: asyncio.subprocess.Process, master_fd: int, sandbox_id: str):
        self.process = process
        self.master_fd = master_fd
        self.pid = process.pid
        self.sandbox_id = sandbox_id
        self._closed = False

    async def write(self, data: bytes) -> None:
        if self._closed:
            raise RuntimeError("PTY 已关闭")
        await asyncio.to_thread(os.write, self.master_fd, data)

    async def resize(self, cols: int, rows: int) -> None:
        if not self._closed:
            packed = struct.pack("HHHH", rows, cols, 0, 0)
            await asyncio.to_thread(fcntl.ioctl, self.master_fd, termios.TIOCSWINSZ, packed)

    async def signal(self, signal_name: str) -> None:
        if signal_name not in {"SIGINT", "SIGTERM", "SIGTSTP"}:
            raise ValueError("PTY signal 不受支持")
        if self.process.returncode is None:
            await asyncio.to_thread(os.killpg, self.process.pid, getattr(signal, signal_name))

    async def close(self, *, force: bool = False) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self.process.returncode is None:
                await asyncio.to_thread(
                    os.killpg, self.process.pid, signal.SIGKILL if force else signal.SIGTERM,
                )
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=3)
                except asyncio.TimeoutError:
                    await asyncio.to_thread(os.killpg, self.process.pid, signal.SIGKILL)
                    await self.process.wait()
        finally:
            os.close(self.master_fd)

    async def output(self):
        while not self._closed:
            try:
                chunk = await asyncio.to_thread(os.read, self.master_fd, 64 * 1024)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    return
                if self._closed:
                    return
                raise
            if not chunk:
                return
            yield chunk


def _tmpfs_spec(settings: SandboxSettings) -> str:
    """把临时配额落实为容器 /tmp 上限，而不是只在宿主机计数。"""
    size = max(64 * 1024 * 1024, int(getattr(settings, "ephemeral_quota_bytes", 64 * 1024 * 1024)))
    return f"/tmp:rw,noexec,nosuid,size={size}"


def _image_ref(settings: SandboxSettings) -> str:
    digest = settings.image_digest.strip()
    if not digest:
        raise ValueError("尚未配置固定镜像 digest")
    if not valid_image_digest(digest):
        raise ValueError("镜像 digest 必须是 sha256: 加 64 位摘要")
    image = settings.image.strip()
    if not image or any(char in image for char in "\r\n "):
        raise ValueError("沙盒镜像名称无效")
    return f"{image}@{digest}"


class DockerSandboxExecutor:
    """使用固定 Rootless Docker 基线执行一条工作区命令。"""

    def __init__(
        self, workspace_root: str | Path, settings: SandboxSettings, *,
        docker_path: str | None = None, personal_root: str | Path | None = None,
        project_root: str | Path | None = None,
        personal_read_only: bool = True, project_read_only: bool = True,
    ):
        root = Path(workspace_root).expanduser().resolve(strict=True)
        if not root.is_dir():
            raise ValueError("workspace 必须是目录")
        self.root = root
        self.personal_root = None
        if personal_root is not None:
            personal_path = Path(personal_root).expanduser().resolve(strict=True)
            if not personal_path.is_dir():
                raise ValueError("personal 根目录必须是目录")
            self.personal_root = personal_path
        self.personal_read_only = bool(personal_read_only)
        self.project_root = None
        if project_root is not None:
            project_path = Path(project_root).expanduser().resolve(strict=True)
            if not project_path.is_dir():
                raise ValueError("project 根目录必须是目录")
            self.project_root = project_path
        self.project_read_only = bool(project_read_only)
        self.settings = settings
        self.docker_path = docker_path or shutil.which("docker")
        if not self.docker_path:
            raise ValueError("未安装 Docker CLI")
        self.image = _image_ref(settings)

    def _daemon_mount_src_for(self, path: Path) -> Path:
        """按目标 Docker daemon 的宿主机视角解析 bind mount 源路径。"""
        host_root = getattr(self.settings, "host_data_root", None)
        if not host_root:
            return path
        from app.core.config import get_settings
        logical_root = Path(get_settings().storage.local_path).resolve()
        try:
            return Path(host_root) / path.relative_to(logical_root)
        except ValueError:
            return path

    def _resolve_cwd(self, cwd: str | Path) -> Path:
        # 复用本机执行器的相对路径和 symlink 约束；容器挂载后仍只暴露这个 root。
        return LocalWorkspaceExecutor(self.root)._resolve_cwd(cwd)

    def _validate_container_interpreter_inputs(self, argv: list[str], *, allow_script_execution: bool = False) -> None:
        """禁止普通 Shell 通过容器执行代码运行时。"""
        interpreter_indexes = [
            index for index, value in enumerate(argv)
            if (
                Path(value).name.lower() in {
                "ash", "awk", "bash", "dash", "ksh", "node", "perl", "python", "python3",
                "pytest", "ruby", "sed", "sh", "zsh",
                }
                or Path(value).name.lower().startswith("python3.")
            )
        ]
        if not interpreter_indexes:
            return
        if allow_script_execution:
            return
        raise ValueError("普通 Shell 禁止直接执行代码运行时，请使用 run_script")

    def build_argv(
        self,
        command: str,
        *,
        cwd: str = ".",
        network_profile: str | None = None,
        container_name: str | None = None,
        allow_script_execution: bool = False,
    ) -> list[str]:
        argv = LocalWorkspaceExecutor._parse_command(command)
        workdir = self._resolve_cwd(cwd)
        self._validate_container_interpreter_inputs(argv, allow_script_execution=allow_script_execution)
        LocalWorkspaceExecutor(self.root)._validate_workspace_argv(
            argv, workdir,
            allowed_absolute_paths=tuple(
                path for path, mounted in (
                    ("/workspace", self.root), ("/personal", self.personal_root),
                    ("/project", self.project_root),
                ) if mounted
            ),
            allow_script_execution=allow_script_execution,
        )
        profile = network_profile or self.settings.network_profile
        if profile not in ("none", "egress"):
            raise ValueError("当前 Shell 沙盒网络策略无效")
        if profile == "egress":
            if not valid_egress_proxy(self.settings.egress_proxy_url):
                raise ValueError("egress 代理未配置")
            if not self.settings.egress_isolation_enabled:
                raise ValueError("受控 egress 网络尚未启用")
            egress_network_name = getattr(self.settings, "egress_network_name", "")
            if not valid_egress_network_name(egress_network_name):
                raise ValueError("egress 网络名无效")
        relative_cwd = workdir.relative_to(self.root)
        container_cwd = _CONTAINER_ROOT / relative_cwd
        return [
            self.docker_path,
            "run",
            "--rm",
            *([f"--name={container_name}"] if container_name else []),
            "--init",
            "--pull=never",
            "--label=com.gugu.sandbox=true",
            f"--label=com.gugu.sandbox.root-id={sandbox_root_label(str(self.root))}",
            f"--network={egress_network_name if profile == 'egress' else 'none'}",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            # Docker 默认加载内置 seccomp profile；不能传 `seccomp=default`，
            # 该值在 Docker CLI 中会被当作 profile 文件路径。
            "--security-opt=apparmor=docker-default",
            f"--pids-limit={max(16, min(int(self.settings.pids_limit), 512))}",
            f"--cpus={max(0.1, min(float(self.settings.cpu_limit), 2.0))}",
            f"--memory={max(64 * 1024 * 1024, int(self.settings.memory_limit_bytes))}",
            f"--tmpfs={_tmpfs_spec(self.settings)}",
            "--ulimit=nofile=1024:1024",
            f"--user={_CONTAINER_USER}",
            # 当前 workspace bind 默认可写；--mount 长语法不接受裸 `rw` 字段。
            f"--mount=type=bind,src={self._daemon_mount_src_for(self.root)},dst={_CONTAINER_ROOT}",
            *([f"--mount=type=bind,src={self._daemon_mount_src_for(self.project_root)},dst=/project{',readonly' if self.project_read_only else ''}"] if self.project_root else []),
            *([f"--mount=type=bind,src={self._daemon_mount_src_for(self.personal_root)},dst=/personal{',readonly' if self.personal_read_only else ''}"] if self.personal_root else []),
            f"--workdir={container_cwd}",
            "--env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "--env=LANG=C.UTF-8",
            "--env=HOME=/",
            *([f"--env=HTTP_PROXY={self.settings.egress_proxy_url}",
               f"--env=HTTPS_PROXY={self.settings.egress_proxy_url}",
               "--env=NO_PROXY=127.0.0.1,localhost"] if profile == "egress" else []),
            self.image,
            *argv,
        ]

    def build_pty_argv(
        self,
        *,
        cwd: str = ".",
        network_profile: str | None = None,
        container_name: str | None = None,
        code_execution_enabled: bool | None = None,
    ) -> list[str]:
        """生成交互式 PTY 的固定启动参数，不接受用户自定义 Shell argv。"""
        # 交互式终端需要 readline；Debian 的 /bin/sh 通常是 dash，Tab 只会被
        # 当作制表符回显，无法提供传统 CLI 的命令和路径补全。
        # --norc 会跳过用户配置；临时 inputrc 放在容器 tmpfs 中，确保 Bash
        # 真正开启 bracketed paste，避免浏览器粘贴多行内容时逐行执行。
        runtime_enabled = getattr(self.settings, "code_execution_enabled", True) if code_execution_enabled is None else code_execution_enabled
        if not runtime_enabled:
            raise ValueError("代码运行环境已关闭，交互式 PTY 不可用")
        shell_command = r'''
printf '%s\n' '$if Bash' 'set enable-bracketed-paste on' '$endif' > /tmp/gugu-inputrc
export INPUTRC=/tmp/gugu-inputrc
# 外层 bash -c 不会可靠地把环境里的 PS1 传给随后 exec 的交互 Bash；显式导出，
# 否则页面终端会退回 Bash 默认的 `bash-5.2$` 提示符。
PS1='gugu-sandbox:\w\$ '
export PS1

# 项目文件的物理目录为「项目名 #ID」，交互式终端允许用户省略内部 ID。
# 只解析 /project 下唯一的项目名；重名时列出可复制的真实路径，不猜测落点。
cd() {
    if [ "$#" -eq 0 ]; then
        builtin cd
        return $?
    fi
    if builtin cd -- "$@" 2>/dev/null; then
        return 0
    fi
    # 逻辑项目路径允许不转义空格；例如 `cd 2026/08/My Project` 会在这里
    # 重新拼成一个路径。物理路径仍可用引号或反斜杠精确访问。
    local requested
    if [ "$#" -eq 1 ]; then
        requested="$1"
    else
        requested="$*"
    fi
    local candidate="$requested"
    if [[ "$candidate" != /project/* ]]; then
        candidate="$PWD/$candidate"
    fi
    # 真实目录已经由前面的 builtin cd 处理；这里只接受不含父目录跳转的
    # /project 相对路径，避免为了规范化路径依赖镜像外部命令。
    [[ "$candidate" != */../* && "$candidate" != */./* ]] || return 1
    [[ "$candidate" == /project/* ]] || return 1

    local relative="${candidate#/project/}"
    local year="${relative%%/*}"
    local after_year="${relative#*/}"
    [[ "$after_year" != "$relative" ]] || return 1
    local month="${after_year%%/*}"
    local after_month="${after_year#*/}"
    [[ "$after_month" != "$month" ]] || return 1
    local project_name="${after_month%%/*}"
    local project_tail=""
    if [[ "$after_month" == */* ]]; then
        project_tail="${after_month#*/}"
    fi
    [ -n "$project_name" ] || return 1

    local parent="/project/$year/$month"
    local nullglob_was_set=0
    shopt -q nullglob && nullglob_was_set=1
    shopt -s nullglob
    local match physical_name suffix
    local -a matches=()
    for match in "$parent/$project_name #"*; do
        [ -d "$match" ] || continue
        physical_name="${match##*/}"
        [[ "$physical_name" == "$project_name #"* ]] || continue
        suffix="${physical_name#"$project_name #"}"
        [[ "$suffix" =~ ^[0-9]+$ ]] || continue
        matches+=("$match")
    done
    [ "$nullglob_was_set" -eq 1 ] || shopt -u nullglob

    if [ "${#matches[@]}" -eq 0 ]; then
        printf '未找到项目目录：%s\n' "$candidate" >&2
        return 1
    fi
    if [ "${#matches[@]}" -gt 1 ]; then
        printf '%s\n' '项目名不唯一，请使用带 ID 的路径：' >&2
        for match in "${matches[@]}"; do
            printf '  cd -- %q\n' "$match" >&2
        done
        return 1
    fi

    local target="${matches[0]}"
    [ -n "$project_tail" ] && target="$target/$project_tail"
    builtin cd -- "$target"
}
export -f cd
exec bash --noprofile --norc -i
'''.strip()
        argv = self.build_argv(
            "bash --noprofile --norc", cwd=cwd, network_profile=network_profile,
            container_name=container_name,
            allow_script_execution=True,
        )
        # 这段命令是服务端固定的启动脚本，不经过用户命令校验器；前面的
        # build_argv 仍负责统一应用镜像、挂载、网络和资源限制参数。
        # shell_command 使用 [[ ]]、数组、shopt 和 export -f 等 Bash 语法，不能
        # 交给 Debian 默认的 /bin/sh（dash）解析，否则页面 PTY 会在启动时直接报
        # “Syntax error: "(" unexpected”。
        argv[-3:] = ["bash", "-c", shell_command]
        run_index = argv.index("run")
        argv[run_index + 1:run_index + 1] = ["--interactive", "--tty"]
        # 沙盒用户是刻意固定的数字 UID，镜像未必为它提供 passwd 名称；
        # 明确提示符，避免 Bash 显示 "I have no name!"，同时标识当前处于沙盒。
        image_index = argv.index(self.image)
        argv[image_index:image_index] = [r"--env=PS1=gugu-sandbox:\w\$ "]
        return argv

    async def open_pty(
        self,
        *,
        cwd: str = ".",
        network_profile: str | None = None,
        container_name: str | None = None,
        code_execution_enabled: bool | None = None,
    ) -> DockerPtyHandle:
        """在固定安全参数的 Docker 容器内启动交互式 PTY。"""
        docker_argv = self.build_pty_argv(
            cwd=cwd, network_profile=network_profile, container_name=container_name,
            code_execution_enabled=code_execution_enabled,
        )
        master_fd, slave_fd = pty.openpty()
        try:
            process = await asyncio.create_subprocess_exec(
                *docker_argv,
                cwd=self.root,
                env=docker_environment(),
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                start_new_session=True,
            )
        except BaseException:
            os.close(master_fd)
            os.close(slave_fd)
            raise
        os.close(slave_fd)
        return DockerPtyHandle(process, master_fd, container_name or "sandbox-pty")

    async def execute(
        self,
        command: str,
        *,
        cwd: str = ".",
        timeout: float | None = None,
        max_output_chars: int | None = None,
        authorization_check: Callable[[], Awaitable[bool]] | None = None,
        on_output: Callable[[str, str], Awaitable[None]] | None = None,
        quota_root: str | Path | None = None,
        quota_bytes: int | None = None,
        network_profile: str | None = None,
    ) -> ShellResult:
        workdir = self._resolve_cwd(cwd)
        container_name = f"gugu-sandbox-{uuid4().hex}"
        docker_argv = self.build_argv(
            command, cwd=cwd, network_profile=network_profile, container_name=container_name,
            allow_script_execution=allow_script_execution,
        )
        timeout_value = max(0.1, min(float(timeout if timeout is not None else self.settings.timeout_seconds), _MAX_TIMEOUT))
        output_limit = max(1, min(int(max_output_chars if max_output_chars is not None else self.settings.output_limit_bytes), _MAX_OUTPUT))

        process = await asyncio.create_subprocess_exec(
            *docker_argv,
            cwd=self.root,
            env=docker_environment(),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        stdout_task = asyncio.create_task(LocalWorkspaceExecutor._read_limited(process.stdout, output_limit, on_output, "stdout"))
        stderr_task = asyncio.create_task(LocalWorkspaceExecutor._read_limited(process.stderr, output_limit, on_output, "stderr"))
        timed_out = False
        permission_revoked = False
        cancelled = False
        wait_task = asyncio.create_task(process.wait())
        auth_task = asyncio.create_task(LocalWorkspaceExecutor._watch_authorization(authorization_check)) if authorization_check else None
        quota_path = Path(quota_root).expanduser().resolve(strict=True) if quota_root else None
        if quota_path is not None and quota_bytes is None:
            raise ValueError("quota_bytes 必须与 quota_root 一起提供")
        quota_task = asyncio.create_task(self._watch_quota(quota_path, quota_bytes)) if quota_path else None
        quota_exceeded = False
        try:
            tasks = {wait_task} | ({auth_task} if auth_task else set()) | ({quota_task} if quota_task else set())
            done, _ = await asyncio.wait(tasks, timeout=timeout_value, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                timed_out = True
            elif quota_task and quota_task in done:
                quota_exceeded = bool(quota_task.result())
            elif auth_task and auth_task in done and not auth_task.result():
                permission_revoked = True
            elif not wait_task.done():
                await wait_task
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            if auth_task and not auth_task.done():
                auth_task.cancel()
                await asyncio.gather(auth_task, return_exceptions=True)
            if quota_task and not quota_task.done():
                quota_task.cancel()
                await asyncio.gather(quota_task, return_exceptions=True)
            if not wait_task.done() and (timed_out or permission_revoked):
                wait_task.cancel()
                await asyncio.gather(wait_task, return_exceptions=True)
            if timed_out or permission_revoked or quota_exceeded or cancelled:
                # 杀掉 docker CLI 不等于杀掉它创建的容器；用受标签/唯一名称
                # 定位当前执行，确保超时、撤权和配额超限不会留下后台容器。
                await self._force_remove_container(container_name)
                self._terminate_process_group(process.pid)
                if process.returncode is None:
                    await process.wait()

        stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
        return ShellResult(
            ok=not timed_out and not permission_revoked and not quota_exceeded and process.returncode == 0,
            exit_code=None if timed_out or permission_revoked or quota_exceeded else process.returncode,
            stdout=stdout[0],
            stderr=stderr[0],
            timed_out=timed_out,
            cwd=str(workdir.relative_to(self.root) or "."),
            truncated=stdout[1] or stderr[1],
            permission_revoked=permission_revoked,
            quota_exceeded=quota_exceeded,
        )

    @staticmethod
    async def _watch_quota(root: Path | None, limit: int | None) -> bool:
        if root is None or limit is None:
            return False
        while True:
            try:
                if measure_directory(root) > limit:
                    return True
            except OSError:
                return True
            await asyncio.sleep(0.1)

    @staticmethod
    def _terminate_process_group(pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    async def _force_remove_container(self, container_name: str) -> None:
        """终止并删除当前执行容器；失败时不遮蔽原始超时/撤权结果。"""
        try:
            cleanup = await asyncio.create_subprocess_exec(
                self.docker_path,
                "rm",
                "--force",
                container_name,
                cwd=self.root,
                env=docker_environment(),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                await asyncio.wait_for(cleanup.wait(), timeout=5)
            except asyncio.TimeoutError:
                cleanup.kill()
                await cleanup.wait()
        except (OSError, asyncio.TimeoutError):
            pass
