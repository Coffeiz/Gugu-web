"""Rootless Docker 沙盒执行器。

Docker 是普通用户 Shell 的真正隔离边界。本模块只接受单条 argv 命令，
并在每次执行时固定写入容器安全参数；业务参数不能覆盖网络、挂载、用户和
Linux capability 配置。
"""
from __future__ import annotations

import asyncio
import os
import signal
import shutil
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

    def __init__(self, workspace_root: str | Path, settings: SandboxSettings, *, docker_path: str | None = None):
        root = Path(workspace_root).expanduser().resolve(strict=True)
        if not root.is_dir():
            raise ValueError("workspace 必须是目录")
        self.root = root
        self.settings = settings
        self.docker_path = docker_path or shutil.which("docker")
        if not self.docker_path:
            raise ValueError("未安装 Docker CLI")
        self.image = _image_ref(settings)

    def _resolve_cwd(self, cwd: str | Path) -> Path:
        # 复用本机执行器的相对路径和 symlink 约束；容器挂载后仍只暴露这个 root。
        return LocalWorkspaceExecutor(self.root)._resolve_cwd(cwd)

    def build_argv(
        self,
        command: str,
        *,
        cwd: str = ".",
        network_profile: str | None = None,
        container_name: str | None = None,
    ) -> list[str]:
        argv = LocalWorkspaceExecutor._parse_command(command)
        workdir = self._resolve_cwd(cwd)
        LocalWorkspaceExecutor(self.root)._validate_workspace_argv(argv, workdir)
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
            # bind mount 默认可写；--mount 长语法不接受裸 `rw` 字段。
            f"--mount=type=bind,src={self.root},dst={_CONTAINER_ROOT}",
            f"--workdir={container_cwd}",
            "--env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "--env=LANG=C.UTF-8",
            *([f"--env=HTTP_PROXY={self.settings.egress_proxy_url}",
               f"--env=HTTPS_PROXY={self.settings.egress_proxy_url}",
               "--env=NO_PROXY=127.0.0.1,localhost"] if profile == "egress" else []),
            self.image,
            *argv,
        ]

    async def execute(
        self,
        command: str,
        *,
        cwd: str = ".",
        timeout: float | None = None,
        max_output_chars: int | None = None,
        authorization_check: Callable[[], Awaitable[bool]] | None = None,
        quota_root: str | Path | None = None,
        quota_bytes: int | None = None,
        network_profile: str | None = None,
    ) -> ShellResult:
        workdir = self._resolve_cwd(cwd)
        container_name = f"gugu-sandbox-{uuid4().hex}"
        docker_argv = self.build_argv(
            command, cwd=cwd, network_profile=network_profile, container_name=container_name,
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
        stdout_task = asyncio.create_task(LocalWorkspaceExecutor._read_limited(process.stdout, output_limit))
        stderr_task = asyncio.create_task(LocalWorkspaceExecutor._read_limited(process.stderr, output_limit))
        timed_out = False
        permission_revoked = False
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
            if timed_out or permission_revoked or quota_exceeded:
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
