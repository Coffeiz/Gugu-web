"""Docker 沙盒运行时探测。

这里只负责读取 Docker 能力，不负责启动容器。容器生命周期由后续
DockerSandboxExecutor/sandboxd 统一管理，避免业务层直接依赖 Docker CLI。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from app.core.config import SandboxSettings


_RESOLVED_IMAGE_DIGEST = "resolved"
_LOCAL_IMAGE_DIGEST = "local"
_RESOLVED_IMAGE_DIGEST_FILE = Path("/run/gugu/sandbox-image-digest")


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


def docker_container_mount_source(
    destination: str = "/data", *, timeout_seconds: float = 2.0,
) -> Path | None:
    """读取当前 sandboxd 容器挂载到 destination 的宿主机源路径。"""
    docker = shutil.which("docker")
    if not docker or not destination.startswith("/"):
        return None
    try:
        result = subprocess.run(
            [docker, "inspect", "--format={{json .Mounts}}", socket.gethostname()],
            capture_output=True, text=True, timeout=timeout_seconds,
            env=docker_environment(), check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    try:
        mounts = json.loads(result.stdout)
    except (TypeError, ValueError):
        return None
    if not isinstance(mounts, list):
        return None
    for mount in mounts:
        if not isinstance(mount, dict) or mount.get("Destination") != destination:
            continue
        source = mount.get("Source")
        if not isinstance(source, str) or not source.startswith("/") or source.startswith("//"):
            continue
        return Path(source).resolve()
    return None


def valid_image_digest(value: str) -> bool:
    digest = (value or "").strip()
    if digest in {_RESOLVED_IMAGE_DIGEST, _LOCAL_IMAGE_DIGEST}:
        return True
    return digest.startswith("sha256:") and len(digest) == len("sha256:") + 64 and all(
        char in "0123456789abcdef" for char in digest[7:].lower()
    )


def resolved_image_digest() -> str | None:
    """读取 Compose bootstrap 从 registry 解析并固定的沙盒镜像 digest。"""
    path = Path(os.environ.get("GUGU_SANDBOX_IMAGE_DIGEST_FILE", str(_RESOLVED_IMAGE_DIGEST_FILE)))
    try:
        digest = path.read_text(encoding="ascii").strip()
    except OSError:
        return None
    if digest.startswith("sha256:") and len(digest) == len("sha256:") + 64 and all(
        char in "0123456789abcdef" for char in digest[7:].lower()
    ):
        return digest
    return None


def valid_resolved_image_digest() -> bool:
    return resolved_image_digest() is not None


def _effective_image_digest(digest: str) -> str | None:
    return resolved_image_digest() if digest == _RESOLVED_IMAGE_DIGEST else digest


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


def cleanup_orphan_pty_containers(*, timeout_seconds: float = 5.0) -> int:
    """清理 sandboxd 重启后遗留的交互式 PTY 容器。

    只查询并删除固定的 ``gugu-pty-`` 命名空间，不接受调用方传入容器名或
    任意 Docker 参数；sandboxd 启动时调用一次即可恢复运行状态一致性。
    """
    docker = shutil.which("docker")
    if not docker:
        return 0
    try:
        listed = subprocess.run(
            [docker, "ps", "-aq", "--filter", "name=^gugu-pty-"],
            capture_output=True, text=True, timeout=timeout_seconds,
            env=docker_environment(), check=False,
        )
        if listed.returncode != 0:
            return 0
        container_ids = [value for value in listed.stdout.split() if re.fullmatch(r"[0-9a-fA-F]{12,64}", value)]
        if not container_ids:
            return 0
        removed = subprocess.run(
            [docker, "rm", "-f", *container_ids[:128]],
            capture_output=True, text=True, timeout=timeout_seconds,
            env=docker_environment(), check=False,
        )
        return len(container_ids[:128]) if removed.returncode == 0 else 0
    except (OSError, subprocess.SubprocessError):
        return 0


def image_available(image: str, digest: str, *, timeout_seconds: float = 3.0) -> bool:
    """确认固定 digest 或 Compose bootstrap 解析的 digest 已加载到目标 daemon。"""
    if not image or not valid_image_digest(digest):
        return False
    docker = shutil.which("docker")
    if not docker:
        return False
    if os.environ.get("GUGU_SANDBOX_OFFLINE") == "1" or digest == _LOCAL_IMAGE_DIGEST:
        inspect_args = [docker, "image", "inspect", image]
    else:
        effective_digest = _effective_image_digest(digest)
        if effective_digest is None:
            return False
        inspect_args = [docker, "image", "inspect", f"{image}@{effective_digest}"]
    try:
        result = subprocess.run(
            inspect_args,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=docker_environment(),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0:
        return False
    return True


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


@dataclass(frozen=True)
class SandboxRuntimeSnapshot:
    docker: DockerRuntimeStatus
    image_ready: bool


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


def probe_sandbox_runtime(settings: SandboxSettings) -> SandboxRuntimeSnapshot:
    """在当前进程持有的 daemon 上采集执行器状态。"""
    docker = probe_docker()
    image_ready = (
        docker.daemon_ready
        and (not settings.rootless_required or docker.rootless is True)
        and valid_image_digest(settings.image_digest)
        and image_available(settings.image, settings.image_digest)
    )
    return SandboxRuntimeSnapshot(docker=docker, image_ready=image_ready)


def _sandbox_configuration_readiness(settings: SandboxSettings) -> tuple[bool, str]:
    if not settings.enabled:
        return False, "Shell 沙盒未开启"
    if settings.network_profile == "egress":
        if not valid_egress_proxy(settings.egress_proxy_url):
            return False, "egress 代理未配置"
        if not settings.egress_isolation_enabled:
            return False, "受控 egress 网络尚未启用"
        if not valid_egress_network_name(settings.egress_network_name):
            return False, "egress 网络名无效"

    return True, "Shell 沙盒配置有效"


def docker_sandbox_readiness(
    settings: SandboxSettings,
    *,
    runtime_snapshot: SandboxRuntimeSnapshot | None = None,
) -> tuple[bool, str]:
    """在 sandboxd 所在进程探测 Docker；调用方必须持有目标 Docker socket。"""
    configured, reason = _sandbox_configuration_readiness(settings)
    if not configured:
        return False, reason
    snapshot = runtime_snapshot or probe_sandbox_runtime(settings)
    status = snapshot.docker
    if not status.installed:
        return False, status.message
    if not status.daemon_ready:
        return False, status.message
    if settings.rootless_required and status.rootless is not True:
        return False, "当前 Docker 不是 Rootless 模式"
    if not valid_image_digest(settings.image_digest):
        return False, "尚未配置有效的固定镜像 digest"
    if not snapshot.image_ready:
        return False, "固定 Shell 沙盒镜像尚未加载到当前 Docker daemon"
    return True, "Docker 沙盒运行时已就绪"


def _sandboxd_status_payload(socket_path: str, *, timeout_seconds: float) -> tuple[dict | None, str | None]:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout_seconds)
            client.connect(socket_path)
            client.sendall(b'{"operation":"status"}\n')
            response = bytearray()
            while b"\n" not in response and len(response) <= 4096:
                chunk = client.recv(4097 - len(response))
                if not chunk:
                    break
                response.extend(chunk)
        if not response or len(response) > 4096:
            return None, "sandboxd 未返回有效状态"
        payload = json.loads(bytes(response).split(b"\n", 1)[0].decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("type") != "status":
            return None, "sandboxd 状态响应无效"
        return payload, None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return None, "sandboxd 不可用，未执行命令"


def sandboxd_runtime_status(
    socket_path: str,
    *,
    timeout_seconds: float = 6.0,
) -> SandboxRuntimeSnapshot | None:
    """读取 sandboxd 实际持有的 daemon 与镜像状态；旧协议或连接失败时返回未知。"""
    payload, _error = _sandboxd_status_payload(socket_path, timeout_seconds=timeout_seconds)
    runtime = payload.get("runtime") if payload is not None else None
    if not isinstance(runtime, dict):
        return None

    installed = runtime.get("installed")
    daemon_ready = runtime.get("daemon_ready")
    rootless = runtime.get("rootless")
    server_version = runtime.get("server_version")
    message = runtime.get("message")
    image_ready = runtime.get("image_ready")
    if (
        not isinstance(installed, bool)
        or not isinstance(daemon_ready, bool)
        or (rootless is not None and not isinstance(rootless, bool))
        or not isinstance(server_version, str)
        or not isinstance(message, str)
        or not isinstance(image_ready, bool)
    ):
        return None
    return SandboxRuntimeSnapshot(
        docker=DockerRuntimeStatus(
            installed=installed,
            daemon_ready=daemon_ready,
            rootless=rootless,
            server_version=server_version,
            message=message,
        ),
        image_ready=image_ready,
    )


def sandboxd_readiness(socket_path: str, *, timeout_seconds: float = 6.0) -> tuple[bool, str]:
    """向 sandboxd 查询其所管理的 Docker 运行时，不探测调用方自己的 daemon。"""
    payload, error = _sandboxd_status_payload(socket_path, timeout_seconds=timeout_seconds)
    if payload is None:
        return False, error or "sandboxd 状态响应无效"
    if payload.get("ready") is True:
        return True, str(payload.get("reason") or "sandboxd Docker 沙盒已就绪")
    return False, str(payload.get("reason") or "sandboxd Docker 沙盒未就绪")


def sandbox_readiness(settings: SandboxSettings) -> tuple[bool, str]:
    """返回当前配置是否允许执行容器命令。

    生产执行经 sandboxd 时只向其查询状态，避免误探测 Worker/Backend 自己的
    Docker daemon；独立运行且未配置 sandboxd 时保留直接探测行为。
    """
    configured, reason = _sandbox_configuration_readiness(settings)
    if not configured:
        return False, reason
    socket_path = str(getattr(settings, "sandboxd_socket", "") or "").strip()
    if socket_path:
        return sandboxd_readiness(socket_path)
    return docker_sandbox_readiness(settings)
