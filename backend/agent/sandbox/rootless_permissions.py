"""Rootless Docker 工作区权限规划。

Rootless 容器中的非 root UID/GID 会映射到宿主机的 subordinate UID/GID。
本模块只负责解析映射并生成显式权限命令，不在 Web/Worker 请求路径中提权或
修改文件权限。实际 apply 应由部署脚本或 sandboxd 执行。
"""
from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SubordinateRange:
    login: str
    start: int
    count: int

    @property
    def end(self) -> int:
        return self.start + self.count - 1

    def map_container_id(self, container_id: int) -> int:
        """映射 container 1..count 到该登录用户的 subordinate ID。"""
        if container_id < 1 or container_id > self.count:
            raise ValueError("容器 ID 超出 subordinate 映射范围")
        return self.start + container_id - 1


@dataclass(frozen=True)
class WorkspacePermissionPlan:
    root: Path
    host_user: str
    mapped_uid: int
    mapped_gid: int
    commands: tuple[tuple[str, ...], ...]


def parse_subordinate_ranges(text: str, login: str) -> tuple[SubordinateRange, ...]:
    """解析 /etc/subuid 或 /etc/subgid 的 login:start:count 内容。"""
    ranges: list[SubordinateRange] = []
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(":")
        if len(parts) != 3:
            raise ValueError(f"第 {line_number} 行 subordinate 配置格式无效")
        owner, start_text, count_text = parts
        if owner != login:
            continue
        try:
            start = int(start_text)
            count = int(count_text)
        except ValueError as exc:
            raise ValueError(f"第 {line_number} 行 subordinate 配置不是数字") from exc
        if start < 0 or count <= 0:
            raise ValueError(f"第 {line_number} 行 subordinate 配置范围无效")
        ranges.append(SubordinateRange(login, start, count))
    return tuple(ranges)


def read_subordinate_ranges(path: str | Path, login: str) -> tuple[SubordinateRange, ...]:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"无法读取 {path}") from exc
    return parse_subordinate_ranges(text, login)


def mapped_id(ranges: tuple[SubordinateRange, ...], container_id: int) -> int:
    """从第一个能覆盖目标 ID 的映射段计算宿主机 ID。"""
    for mapping in ranges:
        if container_id <= mapping.count:
            return mapping.map_container_id(container_id)
    raise ValueError("没有足够的 subordinate ID 映射范围")


def build_permission_plan(
    root: str | Path,
    *,
    login: str,
    subuid: tuple[SubordinateRange, ...],
    subgid: tuple[SubordinateRange, ...],
    container_uid: int = 65532,
    container_gid: int = 65532,
    mapped_uid: int | None = None,
    mapped_gid: int | None = None,
) -> WorkspacePermissionPlan:
    """生成安全的 workspace ACL 初始化计划，不执行任何命令。

    Rootless Docker 使用 subordinate UID/GID 映射；rootful Docker 则直接使用
    容器 UID/GID。调用方可以显式传入已从目标 daemon 解析出的宿主 ID，避免把
    rootless 映射规则错误地应用到另一个 Docker daemon。
    """
    resolved = Path(root).expanduser().resolve(strict=False)
    if not resolved.is_absolute() or resolved == Path("/"):
        raise ValueError("workspace 根目录必须是非根绝对路径")
    if resolved.name in {"", ".", ".."}:
        raise ValueError("workspace 根目录无效")
    uid = mapped_uid if mapped_uid is not None else mapped_id(subuid, container_uid)
    gid = mapped_gid if mapped_gid is not None else mapped_id(subgid, container_gid)
    # 保留宿主机目录 owner，用 ACL 给沙盒映射组读写执行权限。login 可以是
    # 用户名，也可以是数字 UID；后者适用于权限初始化容器未携带宿主机 passwd 的情况。
    commands = (
        ("install", "-d", "-o", login, "-g", str(gid), "-m", "0770", str(resolved)),
        ("setfacl", "-m", f"u:{login}:rwx,g:{gid}:rwx", str(resolved)),
        ("setfacl", "-d", "-m", f"u::rwx,g::rwx,g:{gid}:rwx,m::rwx", str(resolved)),
        ("setfacl", "-R", "-m", f"g:{gid}:rwX", str(resolved)),
        # 仅给根目录设置 default ACL 不够：文件库里已经存在的子目录不会
        # 继承它。对每一级目录设置 default ACL，保证后续 mkdir/上传都可写。
        (
            "find", str(resolved), "-type", "d", "-exec", "setfacl", "-m",
            f"g:{gid}:rwx,m::rwx,d:g:{gid}:rwx,d:m::rwx", "{}", "+",
        ),
    )
    return WorkspacePermissionPlan(resolved, login, uid, gid, commands)


def apply_permission_plan(plan: WorkspacePermissionPlan) -> None:
    """显式应用权限计划；调用方必须自行完成路径和身份审计。"""
    if not shutil.which("setfacl"):
        raise RuntimeError("未安装 setfacl，无法初始化 Rootless workspace ACL")
    for command in plan.commands:
        subprocess.run(command, check=True)


def default_permission_plan(root: str | Path, *, login: str | None = None) -> WorkspacePermissionPlan:
    owner = login or os.environ.get("USER") or os.getlogin()
    return build_permission_plan(
        root,
        login=owner,
        subuid=read_subordinate_ranges("/etc/subuid", owner),
        subgid=read_subordinate_ranges("/etc/subgid", owner),
    )
