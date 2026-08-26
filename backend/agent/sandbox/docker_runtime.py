"""Docker 沙盒运行时探测。

这里只负责读取 Docker 能力，不负责启动容器。容器生命周期由后续
DockerSandboxExecutor/sandboxd 统一管理，避免业务层直接依赖 Docker CLI。
"""
from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import subprocess
from urllib.parse import urlparse
from dataclasses import dataclass

from app.core.config import SandboxSettings


def docker_environment() -> dict[str, str]:
    """返回 Docker CLI 环境，优先使用当前用户的 Rootless socket。

    显式 `DOCKER_HOST` 始终保留给部署配置；未显式配置且当前用户的
    `/run/user/<uid>/docker.sock` 存在时，自动选择该 socket，避免业务服务
    因 systemd 环境缺少变量而误连 rootful daemon。
    """
    env = os.environ.copy()
    if env.get("DOCKER_HOST"):
        return env
    socket = f"/run/user/{os.getuid()}/docker.sock"
    if os.path.exists(socket):
        env["DOCKER_HOST"] = f"unix://{socket}"
    return env


def valid_image_digest(value: str) -> bool:
    digest = (value or "").strip()
    return digest.startswith("sha256:") and len(digest) == len("sha256:") + 64 and all(
        char in "0123456789abcdef" for char in digest[7:].lower()
    )


def valid_egress_proxy(value: str) -> bool:
    """只接受带主机的 HTTP(S) 代理，不允许把任意 URL 当代理注入容器。"""
    parsed = urlparse((value or "").strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname) and not parsed.username and not parsed.password


def valid_egress_network_name(value: str) -> bool:
    """只接受固定 Docker 网络名，避免把配置当成任意 CLI 参数。"""
    return bool(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}", (value or "").strip()))


def docker_network_available(name: str, *, timeout_seconds: float = 2.0) -> bool:
    if not valid_egress_network_name(name):
        return False
    docker = shutil.which("docker")
    if not docker:
        return False
    try:
        result = subprocess.run(
            [docker, "network", "inspect", name], capture_output=True, text=True,
            timeout=timeout_seconds, env=docker_environment(), check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def image_available(image: str, digest: str, *, timeout_seconds: float = 3.0) -> bool:
    """确认固定 digest 已加载到当前 Docker daemon，避免执行时隐式拉取失败。"""
    if not image or not valid_image_digest(digest):
        return False
    docker = shutil.which("docker")
    if not docker:
        return False
    try:
        result = subprocess.run(
            [docker, "image", "inspect", f"{image}@{digest}"],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=docker_environment(),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def cleanup_running_sandboxes(*, timeout_seconds: float = 5.0) -> int:
    """回收仍在运行的临时沙盒容器，不触碰用户挂载目录。

    Docker 执行器使用固定 label 标识临时容器。关闭全局沙盒时只回收这些
    容器，不能用全量 ``docker rm``，也不能删除镜像、卷或宿主机用户数据。
    """
    docker = shutil.which("docker")
    if not docker:
        return 0
    env = docker_environment()
    try:
        listed = subprocess.run(
            [docker, "ps", "-aq", "--filter", "label=com.gugu.sandbox=true"],
            capture_output=True, text=True, timeout=timeout_seconds, env=env, check=False,
        )
        if listed.returncode != 0:
            return 0
        container_ids = tuple(line.strip() for line in listed.stdout.splitlines() if line.strip())
        if not container_ids:
            return 0
        removed = subprocess.run(
            [docker, "rm", "--force", *container_ids], capture_output=True, text=True,
            timeout=timeout_seconds, env=env, check=False,
        )
        return len(container_ids) if removed.returncode == 0 else 0
    except (OSError, subprocess.SubprocessError):
        return 0


def sandbox_root_label(root: str) -> str:
    """返回不暴露真实路径的沙盒根标签，用于按用户回收临时容器。"""
    return hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:24]


def cleanup_sandboxes_for_root(root: str, *, timeout_seconds: float = 5.0) -> int:
    docker = shutil.which("docker")
    if not docker:
        return 0
    try:
        listed = subprocess.run(
            [docker, "ps", "-aq", "--filter", "label=com.gugu.sandbox=true",
             "--filter", f"label=com.gugu.sandbox.root-id={sandbox_root_label(root)}"],
            capture_output=True, text=True, timeout=timeout_seconds,
            env=docker_environment(), check=False,
        )
        ids = tuple(x.strip() for x in listed.stdout.splitlines() if x.strip())
        if listed.returncode != 0 or not ids:
            return 0
        removed = subprocess.run(
            [docker, "rm", "--force", *ids], capture_output=True, text=True,
            timeout=timeout_seconds, env=docker_environment(), check=False,
        )
        return len(ids) if removed.returncode == 0 else 0
    except (OSError, subprocess.SubprocessError):
        return 0


@dataclass(frozen=True)
class DockerRuntimeStatus:
    installed: bool
    daemon_ready: bool
    rootless: bool | None
    server_version: str = ""
    message: str = ""

    @property
    def executor_ready(self) -> bool:
        return self.installed and self.daemon_ready


def probe_docker(*, timeout_seconds: float = 2.0) -> DockerRuntimeStatus:
    """探测 Docker CLI、daemon 和 Rootless 能力，不泄露命令输出到日志。"""
    docker = shutil.which("docker")
    if not docker:
        return DockerRuntimeStatus(False, False, None, message="未安装 Docker CLI")

    try:
        result = subprocess.run(
            [docker, "info", "--format", "{{json .}}"],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=docker_environment(),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return DockerRuntimeStatus(True, False, None, message="Docker daemon 不可用")
    if result.returncode != 0:
        return DockerRuntimeStatus(True, False, None, message="Docker daemon 不可用")

    try:
        info = json.loads(result.stdout)
    except (TypeError, ValueError):
        return DockerRuntimeStatus(True, False, None, message="Docker 状态响应无效")

    security_options = info.get("SecurityOptions") or []
    rootless = any("rootless" in str(option).lower() for option in security_options)
    server_version = str(info.get("ServerVersion") or "")
    return DockerRuntimeStatus(
        True,
        True,
        rootless,
        server_version=server_version,
        message="Docker daemon 已就绪",
    )


def sandbox_readiness(settings: SandboxSettings) -> tuple[bool, str]:
    """返回当前配置是否允许执行容器命令。

    这里是执行前的三层门禁之一：沙盒关闭、Docker 不可用、Rootless 不满足或
    镜像未固定 digest 时，都必须拒绝执行，不能回退到本机执行器。
    """
    if not settings.enabled:
        return False, "Shell 沙盒未开启"
    if settings.network_profile == "egress":
        if not valid_egress_proxy(settings.egress_proxy_url):
            return False, "egress 代理未配置"
        if not settings.egress_isolation_enabled:
            return False, "受控 egress 网络尚未启用"
        if not valid_egress_network_name(settings.egress_network_name):
            return False, "egress 网络名无效"
    status = probe_docker()
    if not status.installed:
        return False, status.message
    if not status.daemon_ready:
        return False, status.message
    if settings.rootless_required and status.rootless is not True:
        return False, "当前 Docker 不是 Rootless 模式"
    if not valid_image_digest(settings.image_digest):
        return False, "尚未配置有效的固定镜像 digest"
    if not image_available(settings.image, settings.image_digest):
        return False, "固定 Shell 沙盒镜像尚未加载到当前 Docker daemon"
    return True, "Docker 沙盒运行时已就绪"
