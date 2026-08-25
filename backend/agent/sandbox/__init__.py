"""Shell 执行后端。执行器只接受已经通过策略层授权的工作区。"""

from .local_executor import LocalWorkspaceExecutor, ShellResult
from .docker_runtime import DockerRuntimeStatus, docker_environment, image_available, probe_docker, sandbox_readiness, valid_image_digest
from .docker import DockerSandboxExecutor
from .rootless_permissions import (
    SubordinateRange,
    WorkspacePermissionPlan,
    build_permission_plan,
    parse_subordinate_ranges,
)
from .quota import SandboxQuotaSnapshot, can_reserve, measure_directory, snapshot_quota
from .client import SandboxdClient, SandboxdUnavailable

__all__ = [
    "DockerRuntimeStatus", "DockerSandboxExecutor", "LocalWorkspaceExecutor", "ShellResult",
    "SubordinateRange", "WorkspacePermissionPlan", "build_permission_plan", "docker_environment", "image_available",
    "parse_subordinate_ranges", "probe_docker", "sandbox_readiness", "valid_image_digest",
    "SandboxQuotaSnapshot", "can_reserve", "measure_directory", "snapshot_quota",
    "SandboxdClient", "SandboxdUnavailable",
]
