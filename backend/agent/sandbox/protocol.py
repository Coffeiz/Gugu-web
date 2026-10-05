"""sandboxd 的最小 JSON Lines 协议。"""
from __future__ import annotations

import json
import math
from pathlib import PurePosixPath
import time
from dataclasses import dataclass
from typing import Any, Literal


def validate_workspace_target(target: str) -> None:
    path = PurePosixPath(target)
    if (not path.is_absolute() or path.parts[0] != "/" or len(path.parts) < 3
            or path.parts[1] not in {"workspace", "personal", "project"}
            or ".." in path.parts or path.as_posix() != target
            or any(char in target for char in (",", "\x00", "\n", "\r"))):
        raise ValueError("workspace mount 目标路径无效")


def workspace_target_for(relative: str) -> str:
    """用户存储内相对路径到容器规范路径的唯一映射。"""
    path = PurePosixPath(relative)
    library = {"项目文件": "project", "个人文件": "personal", "workspace": "workspace"}.get(path.parts[0] if path.parts else "")
    if library is None or len(path.parts) < 2:
        raise ValueError("工作区来源不属于可挂载的文件空间")
    target = str(PurePosixPath("/") / library / PurePosixPath(*path.parts[1:]))
    validate_workspace_target(target)
    return target


@dataclass(frozen=True)
class WorkspaceMount:
    """单个经过业务层授权的工作区挂载。"""

    target: str
    root: str

    def __post_init__(self) -> None:
        validate_workspace_target(self.target)
        if not self.root.strip():
            raise ValueError("workspace mount 根目录不能为空")

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "WorkspaceMount":
        if not isinstance(value, dict):
            raise ValueError("workspace mount 无效")
        return cls(target=str(value.get("target") or ""), root=str(value.get("root") or ""))


def _parse_workspace_mounts(value: Any) -> tuple[tuple[WorkspaceMount, ...], str | None]:
    values = value.get("workspace_mounts") or []
    if not isinstance(values, list) or len(values) > 64:
        raise ValueError("sandboxd workspace_mounts 无效")
    mounts = tuple(WorkspaceMount.from_dict(item) for item in values)
    names = [item.target for item in mounts]
    if len(names) != len(set(names)):
        raise ValueError("sandboxd workspace mount 名称重复")
    primary = str(value.get("primary_workspace") or "").strip() or None
    if mounts and primary not in names:
        raise ValueError("sandboxd primary_workspace 未在挂载清单中")
    if not mounts and primary is not None:
        raise ValueError("sandboxd primary_workspace 缺少挂载清单")
    return mounts, primary


@dataclass(frozen=True)
class ExecuteRequest:
    root: str
    command: str
    cwd: str = "."
    timeout: float = 30
    max_output_chars: int = 12_000
    quota_root: str | None = None
    quota_bytes: int | None = None
    network_profile: Literal["none", "egress"] = "none"
    egress_expires_at: float | None = None
    request_id: str | None = None
    personal_root: str | None = None
    project_root: str | None = None
    personal_read_only: bool = True
    project_read_only: bool = True
    workspace_mounts: tuple[WorkspaceMount, ...] = ()
    primary_workspace: str | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ExecuteRequest":
        root = str(value.get("root") or "").strip()
        command = str(value.get("command") or "").strip()
        if not root or not command:
            raise ValueError("sandboxd 请求缺少 root 或 command")
        timeout = float(value.get("timeout", 30))
        max_output_chars = int(value.get("max_output_chars", 12_000))
        quota_root = str(value.get("quota_root") or "").strip() or None
        quota_value = value.get("quota_bytes")
        quota_bytes = int(quota_value) if quota_value is not None else None
        network_profile = str(value.get("network_profile") or "none")
        if network_profile not in ("none", "egress"):
            raise ValueError("sandboxd network_profile 无效")
        expires_value = value.get("egress_expires_at")
        egress_expires_at = float(expires_value) if expires_value is not None else None
        if network_profile == "egress":
            if (
                egress_expires_at is None
                or not math.isfinite(egress_expires_at)
                or egress_expires_at <= time.time()
            ):
                raise ValueError("sandboxd egress 授权已过期")
        elif egress_expires_at is not None:
            raise ValueError("断网请求不能携带 egress 授权")
        if quota_bytes is not None and quota_bytes < 1:
            raise ValueError("sandboxd quota_bytes 无效")
        if quota_bytes is not None and not quota_root:
            raise ValueError("sandboxd quota_bytes 缺少 quota_root")
        workspace_mounts, primary_workspace = _parse_workspace_mounts(value)
        if not 0.1 <= timeout <= 300:
            raise ValueError("sandboxd timeout 超出允许范围")
        if not 1 <= max_output_chars <= 120_000:
            raise ValueError("sandboxd 输出上限超出允许范围")
        return cls(
            request_id=str(value.get("request_id") or "").strip() or None,
            root=root,
            command=command,
            cwd=str(value.get("cwd") or "."),
            timeout=timeout,
            max_output_chars=max_output_chars,
            quota_root=quota_root,
            quota_bytes=quota_bytes,
            network_profile=network_profile,
            egress_expires_at=egress_expires_at,
            personal_root=str(value.get("personal_root") or "").strip() or None,
            project_root=str(value.get("project_root") or "").strip() or None,
            personal_read_only=bool(value.get("personal_read_only", True)),
            project_read_only=bool(value.get("project_read_only", True)),
            workspace_mounts=workspace_mounts,
            primary_workspace=primary_workspace,
        )

    def to_json(self) -> bytes:
        return (json.dumps({
            "operation": "execute",
            **({"request_id": self.request_id} if self.request_id else {}),
            "root": self.root,
            "command": self.command,
            "cwd": self.cwd,
            "timeout": self.timeout,
            "max_output_chars": self.max_output_chars,
            "quota_root": self.quota_root,
            "quota_bytes": self.quota_bytes,
            "network_profile": self.network_profile,
            "egress_expires_at": self.egress_expires_at,
            "personal_root": self.personal_root,
            "project_root": self.project_root,
            "personal_read_only": self.personal_read_only,
            "project_read_only": self.project_read_only,
            "workspace_mounts": [
                {"target": mount.target, "root": mount.root} for mount in self.workspace_mounts
            ],
            "primary_workspace": self.primary_workspace,
        }, ensure_ascii=False) + "\n").encode("utf-8")


def encode_response(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False) + "\n").encode("utf-8")
