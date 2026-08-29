"""本机工作区 Shell 执行器。

当前版本只在已解析的 workspace 根目录内启动当前系统用户的子进程，不使用
shell=True，不接受管道、重定向、命令替换或宿主机绝对路径。
"""
from __future__ import annotations

import asyncio
import os
import re
import signal
import shlex
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Awaitable, Callable


_SHELL_META = set(";&|<>$`()\n\r")
_MAX_TIMEOUT = 300
_MAX_OUTPUT = 120_000
_PATH_SEPARATOR_RE = re.compile(r"[\\/]+")
_SCRIPT_INTERPRETERS = frozenset({
    "ash", "awk", "bash", "dash", "ksh", "node", "perl", "python", "python3",
    "ruby", "sed", "sh", "zsh",
})
_INTERPRETER_EVAL_FLAGS = frozenset({
    "-c", "--command", "-e", "--eval", "--execute", "--expression",
})


@dataclass(frozen=True)
class ShellResult:
    ok: bool
    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool
    cwd: str
    truncated: bool = False
    permission_revoked: bool = False
    quota_exceeded: bool = False


class LocalWorkspaceExecutor:
    """在当前系统用户下执行受限于 workspace 的单条命令。

    这是可信本机执行后端，不是面向不受信用户的安全隔离边界。
    """

    def __init__(
        self,
        workspace_root: str | Path,
        *,
        env: dict[str, str] | None = None,
        restrict_interpreter_inputs: bool = True,
    ):
        root = Path(workspace_root).expanduser().resolve(strict=True)
        if not root.is_dir():
            raise ValueError("workspace 必须是目录")
        self.root = root
        self.restrict_interpreter_inputs = restrict_interpreter_inputs
        base_env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL") if key in os.environ}
        if env:
            base_env.update(env)
        self.env = base_env

    def _resolve_cwd(self, cwd: str | Path) -> Path:
        value = Path(cwd)
        if value.is_absolute():
            raise ValueError("cwd 必须是 workspace 内的相对路径")
        resolved = (self.root / value).resolve(strict=True)
        try:
            resolved.relative_to(self.root)
        except ValueError as exc:
            raise ValueError("cwd 超出 workspace 范围") from exc
        if not resolved.is_dir():
            raise ValueError("cwd 必须是目录")
        return resolved

    def _validate_workspace_argv(self, argv: list[str], workdir: Path) -> None:
        """阻止 workspace 命令通过参数访问 workspace 外的路径。

        ``cwd`` 校验无法覆盖 ``ls ..``、``cat /etc/passwd`` 这类参数路径。
        当前本机执行器没有 OS 级容器，因此先对显式路径做 fail-closed 预检；
        system scope 使用 root 为 ``/``，不受这条 workspace 边界限制。
        """
        if self.root == Path("/"):
            return
        for raw_value in argv[1:]:
            value = raw_value.split("=", 1)[1] if "=" in raw_value else raw_value
            if not value or value.startswith("-") and "/" not in value and "\\" not in value:
                continue
            if value.startswith("~") or Path(value).is_absolute() or value.startswith(("/", "\\")):
                raise ValueError("workspace 命令不能使用绝对路径或用户目录路径")
            parts = [part for part in _PATH_SEPARATOR_RE.split(value) if part]
            if ".." in parts:
                raise ValueError("命令路径超出 workspace 范围")
            # 只对显式路径形态解析，避免把普通参数当成文件名处理。
            if "/" not in value and "\\" not in value and not value.startswith("."):
                # 硬链接不会通过路径 resolve 到 workspace 外；对已存在的普通文件
                # 检查 inode 链数，避免把 workspace 内的名字当成外部文件的安全边界。
                candidate = workdir / value
                if candidate.is_symlink():
                    resolved_link = candidate.resolve(strict=False)
                    try:
                        resolved_link.relative_to(self.root)
                    except ValueError as exc:
                        raise ValueError("命令路径超出 workspace 范围") from exc
                try:
                    stat = candidate.stat()
                except OSError:
                    stat = None
                if stat is not None and candidate.is_file() and stat.st_nlink > 1:
                    raise ValueError("workspace 命令不能使用硬链接文件")
                continue
            candidate = (workdir / value).resolve(strict=False)
            try:
                candidate.relative_to(self.root)
            except ValueError as exc:
                raise ValueError("命令路径超出 workspace 范围") from exc
            try:
                stat = candidate.stat()
            except OSError:
                stat = None
            if stat is not None and candidate.is_file() and stat.st_nlink > 1:
                raise ValueError("workspace 命令不能使用硬链接文件")

        if self.restrict_interpreter_inputs:
            self._validate_interpreter_inputs(argv, workdir)

    def _validate_interpreter_inputs(self, argv: list[str], workdir: Path) -> None:
        """禁止把 workspace 文件直接交给解释器执行。

        ``create_subprocess_exec`` 不会解析命令替换，但 ``bash script.sh``、
        ``env bash script.sh`` 和 ``xargs -a input bash`` 仍会执行不受信文件。
        这不是 workspace 路径越界问题，而是文件内容注入问题，因此不能只依赖
        容器的只读、断网和低权限配置来兜底。
        """
        interpreter_indexes = [
            index for index, value in enumerate(argv)
            if Path(value).name.lower() in _SCRIPT_INTERPRETERS
        ]
        if not interpreter_indexes:
            return

        # 解释器的 inline/eval 模式可以绕过“脚本文件参数”检查，例如
        # ``bash -c 'source payload.sh'``；Agent shell 不需要嵌套解释器，直接拒绝。
        for index in interpreter_indexes:
            if any(value in _INTERPRETER_EVAL_FLAGS for value in argv[index + 1:]):
                raise ValueError("禁止通过解释器执行 inline/eval 代码")

        # 检查整条 argv，而不是只检查解释器后的参数，以覆盖 env/xargs 包装器：
        # ``xargs -a payload.txt bash`` 中 payload.txt 位于 bash 之前。
        for raw_value in argv[1:]:
            value = raw_value.split("=", 1)[1] if "=" in raw_value else raw_value
            if not value or value.startswith("-"):
                continue
            candidate = (workdir / value).resolve(strict=False)
            try:
                candidate.relative_to(self.root)
            except ValueError:
                continue
            try:
                is_file = candidate.is_file()
            except OSError:
                is_file = False
            if is_file:
                raise ValueError("禁止将 workspace 文件直接交给解释器执行")

    @staticmethod
    def _parse_command(command: str) -> list[str]:
        text = (command or "").strip()
        if not text:
            raise ValueError("command 不能为空")
        if any(char in text for char in _SHELL_META):
            raise ValueError("当前执行器不支持管道、重定向或命令替换")
        try:
            argv = shlex.split(text, posix=True)
        except ValueError as exc:
            raise ValueError("command 引号格式无效") from exc
        if not argv:
            raise ValueError("command 不能为空")
        return argv

    async def execute(
        self,
        command: str,
        *,
        cwd: str = ".",
        timeout: float = 30,
        max_output_chars: int = 12_000,
        authorization_check: Callable[[], Awaitable[bool]] | None = None,
        on_output: Callable[[str, str], Awaitable[None]] | None = None,
    ) -> ShellResult:
        argv = self._parse_command(command)
        workdir = self._resolve_cwd(cwd)
        self._validate_workspace_argv(argv, workdir)
        timeout = max(0.1, min(float(timeout), _MAX_TIMEOUT))
        output_limit = max(1, min(int(max_output_chars), _MAX_OUTPUT))

        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                cwd=workdir,
                env=self.env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except FileNotFoundError:
            return ShellResult(False, 127, "", f"找不到命令：{argv[0]}", False, str(workdir.relative_to(self.root) or ".") )
        except PermissionError:
            return ShellResult(False, 126, "", f"没有执行权限：{argv[0]}", False, str(workdir.relative_to(self.root) or ".") )
        stdout_task = asyncio.create_task(self._read_limited(process.stdout, output_limit, on_output, "stdout"))
        stderr_task = asyncio.create_task(self._read_limited(process.stderr, output_limit, on_output, "stderr"))
        timed_out = False
        permission_revoked = False
        cancelled = False
        try:
            wait_task = asyncio.create_task(process.wait())
            auth_task = (
                asyncio.create_task(self._watch_authorization(authorization_check))
                if authorization_check else None
            )
            tasks = {wait_task} | ({auth_task} if auth_task else set())
            done, _ = await asyncio.wait(tasks, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                timed_out = True
            elif auth_task and auth_task in done and not auth_task.result():
                permission_revoked = True
            else:
                await wait_task
            if auth_task and not auth_task.done():
                auth_task.cancel()
                await asyncio.gather(auth_task, return_exceptions=True)
            if not wait_task.done():
                wait_task.cancel()
                await asyncio.gather(wait_task, return_exceptions=True)
        except asyncio.CancelledError:
            cancelled = True
            raise
        except asyncio.TimeoutError:
            timed_out = True
        finally:
            if timed_out or permission_revoked or cancelled:
                self._terminate_process_group(process.pid)
                await process.wait()
        stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
        return ShellResult(
            ok=not timed_out and not permission_revoked and process.returncode == 0,
            exit_code=None if timed_out or permission_revoked else process.returncode,
            stdout=stdout[0],
            stderr=stderr[0],
            timed_out=timed_out,
            cwd=str(workdir.relative_to(self.root) or "."),
            truncated=stdout[1] or stderr[1],
            permission_revoked=permission_revoked,
        )

    @staticmethod
    async def _watch_authorization(check: Callable[[], Awaitable[bool]]) -> bool:
        while True:
            try:
                allowed = await check()
            except Exception:
                allowed = False
            if not allowed:
                return False
            await asyncio.sleep(0.25)

    @staticmethod
    async def _read_limited(stream, limit: int, on_output=None, stream_name: str = "stdout") -> tuple[str, bool]:
        chunks: list[bytes] = []
        size = 0
        truncated = False
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            remaining = limit - size
            if remaining > 0:
                accepted = chunk[:remaining]
                chunks.append(accepted)
                size += len(accepted)
                if on_output is not None and accepted:
                    await on_output(stream_name, accepted.decode("utf-8", errors="replace"))
            if len(chunk) > remaining:
                truncated = True
        return b"".join(chunks).decode("utf-8", errors="replace"), truncated

    @staticmethod
    def _terminate_process_group(pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
