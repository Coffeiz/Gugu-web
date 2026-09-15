"""Rootless Docker 工作区权限规划。

Rootless 容器中的非 root UID/GID 会映射到宿主机的 subordinate UID/GID。
本模块负责解析映射、生成权限命令，并在 workspace 初始化时应用 ACL。Compose
运行时映射由 sandbox-bootstrap 探测后共享；本机开发环境可从 subordinate ID 推导。
"""
from __future__ import annotations

import json
import logging
import os
import pwd
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

_logger = logging.getLogger(__name__)


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
    apply_ownership: bool = True,
) -> WorkspacePermissionPlan:
    """生成安全的 workspace ACL 初始化计划，不执行任何命令。

    Rootless Docker 使用 subordinate UID/GID 映射；rootful Docker 则直接使用
    容器 UID/GID。调用方可以显式传入已从目标 daemon 解析出的宿主 ID，避免把
    rootless 映射规则错误地应用到另一个 Docker daemon。

    apply_ownership=False 适用于以部署用户（非 root）身份执行的运行时初始化：
    chown/chgrp 到映射组需要 root，此时退化为仅 chmod + setfacl——沙盒映射身份
    的访问由命名 ACL 条目和每级目录 default ACL 继承保证，不依赖文件属组。
    """
    resolved = Path(root).expanduser().resolve(strict=False)
    if not resolved.is_absolute() or resolved == Path("/"):
        raise ValueError("workspace 根目录必须是非根绝对路径")
    if resolved.name in {"", ".", ".."}:
        raise ValueError("workspace 根目录无效")
    uid = mapped_uid if mapped_uid is not None else mapped_id(subuid, container_uid)
    gid = mapped_gid if mapped_gid is not None else mapped_id(subgid, container_gid)
    # 保留宿主机目录 owner，同时显式给宿主服务用户和沙盒映射组访问权限。
    # 沙盒容器会在 bind mount 中创建脚本/缓存目录；这些 inode 的 owner 是
    # subordinate UID。若只给映射组权限，宿主 backend 无法在该目录创建原子
    # 替换文件，表现为 edit_file 的 PermissionError。login 可以是用户名，也
    # 可以是数字 UID；后者适用于权限初始化容器未携带宿主机 passwd 的情况。
    if apply_ownership:
        head = (("install", "-d", "-o", login, "-g", str(gid), "-m", "0770", str(resolved)),)
    else:
        head = (("chmod", "0770", str(resolved)),)
    commands = head + (
        ("setfacl", "-m", f"u:{login}:rwx,g:{gid}:rwx", str(resolved)),
        ("setfacl", "-d", "-m", f"u::rwx,u:{login}:rwx,g::rwx,g:{gid}:rwx,m::rwx", str(resolved)),
        # 递归只处理属于 login 的条目：沙盒映射身份在目录里创建的文件不归
        # 部署用户所有，setfacl 会 EPERM 并中断整批；这些条目沙盒天然可读写，
        # 无需补 ACL（find -user 接受数字 UID，兼容初始化容器无 passwd 的情况）。
        (
            "find", str(resolved), "-user", login, "-exec", "setfacl", "-m",
            f"u:{login}:rwX,g:{gid}:rwX", "{}", "+",
        ),
        # 仅给根目录设置 default ACL 不够：文件库里已经存在的子目录不会
        # 继承它。对每一级目录设置 default ACL，保证后续 mkdir/上传都可写。
        (
            "find", str(resolved), "-type", "d", "-user", login, "-exec", "setfacl", "-m",
            f"u:{login}:rwx,g:{gid}:rwx,m::rwx,d:u:{login}:rwx,d:g:{gid}:rwx,d:m::rwx", "{}", "+",
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


# 沙盒容器内业务进程的固定 UID/GID（与 prepare_rootless_storage.py 保持一致）。
_CONTAINER_SANDBOX_UID = 65532
_CONTAINER_SANDBOX_GID = 65532
_RUNTIME_IDENTITY_PATH = Path("/run/gugu/sandbox-storage-identity.json")
# 进程生命周期内的幂等缓存：每棵挂载根只需补一次 ACL，重复递归 setfacl 纯属浪费。
_acl_ready_roots: set[str] = set()
_acl_warned_roots: set[str] = set()


def _read_runtime_identity() -> tuple[int, int] | None:
    """读取 bootstrap 按目标 Docker daemon 实际探测出的沙盒宿主 UID/GID。

    Web/Worker 容器通常看不到目标 Docker socket，也没有宿主机 subordinate ID
    配置，因此不能自行判断目标 daemon 是 rootful 还是 rootless。Compose bootstrap
    与运行时共享 /run/gugu 卷，这份小型元数据是 daemon 身份映射的唯一权威来源。
    文件不存在时保留原生开发环境的 /etc/subuid 推导行为。
    """
    try:
        payload = json.loads(_RUNTIME_IDENTITY_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("无法读取沙盒 daemon 身份映射") from exc
    if not isinstance(payload, dict) or payload.get("schema") != 1:
        raise ValueError("沙盒 daemon 身份映射版本无效")
    if payload.get("daemon_mode") not in {"rootful", "rootless"}:
        raise ValueError("沙盒 daemon 模式无效")
    if payload.get("container_uid") != _CONTAINER_SANDBOX_UID or payload.get("container_gid") != _CONTAINER_SANDBOX_GID:
        raise ValueError("沙盒 daemon 身份映射与容器 UID/GID 不匹配")
    mapped_uid = payload.get("mapped_uid")
    mapped_gid = payload.get("mapped_gid")
    if (
        not isinstance(mapped_uid, int) or isinstance(mapped_uid, bool) or mapped_uid < 0
        or not isinstance(mapped_gid, int) or isinstance(mapped_gid, bool) or mapped_gid < 0
    ):
        raise ValueError("沙盒 daemon 身份映射 UID/GID 无效")
    return mapped_uid, mapped_gid


def ensure_sandbox_acl(root: str | Path) -> bool:
    """运行时为单棵沙盒挂载根补齐 rootless ACL；成功返回 True。

    与 sandbox-bootstrap 一次性脚本（prepare_rootless_storage.py）使用同一套
    权限计划。Compose 中优先读取 bootstrap 按目标 daemon 检测并共享的 UID/GID；
    非 Compose 的原生开发环境则按当前用户的 subordinate ID 推导。环境不满足
    （无 setfacl、映射不可用、命令执行失败）时返回 False，由调用方处理权限兜底。
    """
    resolved = str(Path(root).expanduser().resolve())
    if resolved in _acl_ready_roots:
        return True
    try:
        if not shutil.which("setfacl"):
            raise RuntimeError("未安装 setfacl")
        login = pwd.getpwuid(os.getuid()).pw_name
        runtime_identity = _read_runtime_identity()
        subuid: tuple[SubordinateRange, ...] = ()
        subgid: tuple[SubordinateRange, ...] = ()
        mapped_uid: int | None = None
        mapped_gid: int | None = None
        if runtime_identity is not None:
            mapped_uid, mapped_gid = runtime_identity
        else:
            subuid = read_subordinate_ranges("/etc/subuid", login)
            subgid = read_subordinate_ranges("/etc/subgid", login)
        plan = build_permission_plan(
            resolved,
            login=login,
            subuid=subuid,
            subgid=subgid,
            container_uid=_CONTAINER_SANDBOX_UID,
            container_gid=_CONTAINER_SANDBOX_GID,
            mapped_uid=mapped_uid,
            mapped_gid=mapped_gid,
            # 非 root 运行时无法 chgrp 到映射组（EPERM），只做 chmod + setfacl。
            apply_ownership=os.geteuid() == 0,
        )
        apply_permission_plan(plan)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        if resolved not in _acl_warned_roots:
            _acl_warned_roots.add(resolved)
            _logger.warning("沙盒 ACL 初始化失败，降级为全员可写兜底（%s）：%s", resolved, exc)
        return False
    _acl_ready_roots.add(resolved)
    return True
