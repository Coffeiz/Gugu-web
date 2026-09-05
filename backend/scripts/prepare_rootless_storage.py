#!/usr/bin/env python3
"""初始化 Compose 沙盒可写存储的 Rootless ACL。

该脚本只由 Compose 的 sandbox-bootstrap 一次性服务调用。它处理所有用户的
``shell``、``个人文件``、``项目文件``根目录，现有目录递归补 ACL，并给每一级
目录设置 default ACL。Web/Worker 请求路径不提权、不调用 setfacl。
"""
from __future__ import annotations

import argparse
import os
import pwd
import shutil
import subprocess
import uuid
from pathlib import Path

from agent.sandbox.rootless_permissions import (
    SubordinateRange,
    apply_permission_plan,
    build_permission_plan,
    mapped_id,
    read_subordinate_ranges,
)


_WRITABLE_ROOT_NAMES = ("shell", "个人文件", "项目文件")
_CONTAINER_UID = 65532
_CONTAINER_GID = 65532


def discover_writable_roots(users_root: str | Path) -> tuple[Path, ...]:
    """返回所有用户可被绑定到 ``/workspace`` 的持久目录。"""
    root = Path(users_root).expanduser().resolve(strict=True)
    if root == Path("/") or root.name != "users" or not root.is_dir():
        raise ValueError("用户数据根目录必须是专门的 users 目录")
    result: list[Path] = []
    for user_root in sorted(root.iterdir(), key=lambda item: item.name):
        if not user_root.is_dir() or user_root.name.startswith("."):
            continue
        result.extend(user_root / name for name in _WRITABLE_ROOT_NAMES)
    return tuple(result)


def _docker_info(socket_path: str) -> tuple[bool, int]:
    docker = shutil.which("docker")
    if not docker:
        raise RuntimeError("未安装 Docker CLI")
    socket = Path(socket_path)
    try:
        socket_uid = socket.stat().st_uid
    except OSError as exc:
        raise RuntimeError("无法读取目标 Docker socket 所属用户") from exc
    result = subprocess.run(
        [docker, "-H", f"unix://{socket}", "info", "--format", "{{json .SecurityOptions}}"],
        capture_output=True, text=True, timeout=10, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("目标 Docker daemon 不可用")
    return "rootless" in result.stdout.lower(), socket_uid


def _host_login(socket_uid: int, explicit: str | None) -> str:
    if explicit:
        return explicit
    try:
        return pwd.getpwuid(socket_uid).pw_name
    except KeyError:
        pass
    passwd_path = Path("/host/etc/passwd")
    try:
        for line in passwd_path.read_text(encoding="utf-8").splitlines():
            fields = line.split(":")
            if len(fields) > 2 and fields[2].isdigit() and int(fields[2]) == socket_uid:
                return fields[0]
    except OSError:
        pass
    raise RuntimeError("无法确定 Rootless Docker 登录用户，请设置 GUGU_ROOTLESS_LOGIN")


def _host_subordinate_ranges(login: str) -> tuple[tuple[SubordinateRange, ...], tuple[SubordinateRange, ...]]:
    subuid_path = Path("/host/etc/subuid") if Path("/host/etc/subuid").is_file() else Path("/etc/subuid")
    subgid_path = Path("/host/etc/subgid") if Path("/host/etc/subgid").is_file() else Path("/etc/subgid")
    return read_subordinate_ranges(subuid_path, login), read_subordinate_ranges(subgid_path, login)


def _probe_root(
    root: Path,
    *,
    users_root: Path,
    docker_socket: str,
    image_ref: str,
) -> None:
    docker = shutil.which("docker")
    assert docker is not None
    relative = root.relative_to(users_root)
    host_data_root_value = os.environ.get("SANDBOX__HOST_DATA_ROOT", "").strip()
    if not host_data_root_value:
        raise RuntimeError("SANDBOX__HOST_DATA_ROOT 未配置，无法验证目标 daemon 的 bind mount")
    host_data_root = Path(host_data_root_value).expanduser()
    if not host_data_root.is_absolute():
        raise RuntimeError("SANDBOX__HOST_DATA_ROOT 必须是宿主机可见的绝对路径")
    host_root = (host_data_root / relative).resolve()
    probe_name = f".gugu-sandbox-probe-{uuid.uuid4().hex}"
    command = (
        "set -eu; touch /workspace/" + probe_name + "; "
        "rm -f /workspace/" + probe_name
    )
    argv = [
        docker, "-H", f"unix://{docker_socket}", "run", "--rm", "--pull=never",
        "--network=none", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--user=65532:65532",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        f"--mount=type=bind,src={host_root},dst=/workspace",
        image_ref, "sh", "-c", command,
    ]
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=30, check=False)
    except subprocess.SubprocessError as exc:
        raise RuntimeError("沙盒 Workspace 写入探针未能启动") from exc
    finally:
        try:
            (root / probe_name).unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
    if result.returncode != 0:
        raise RuntimeError("沙盒 Workspace 写入探针失败，请检查 Rootless UID/GID 映射和 ACL")


def prepare(
    users_root: str | Path,
    *,
    login: str | None,
    docker_socket: str,
    image_ref: str,
    probe: bool,
) -> int:
    root = Path(users_root).expanduser().resolve(strict=True)
    roots = discover_writable_roots(root)
    rootless, socket_uid = _docker_info(docker_socket)
    host_owner_uid = root.stat().st_uid
    mapped_uid = _CONTAINER_UID
    mapped_gid = _CONTAINER_GID
    if rootless:
        rootless_login = _host_login(socket_uid, login)
        subuid, subgid = _host_subordinate_ranges(rootless_login)
        mapped_uid = mapped_id(subuid, _CONTAINER_UID)
        mapped_gid = mapped_id(subgid, _CONTAINER_GID)
    else:
        subuid = subgid = ()

    for writable_root in roots:
        plan = build_permission_plan(
            writable_root,
            # 容器内可能没有宿主机用户名，ACL/owner 命令统一使用数字 UID。
            login=str(host_owner_uid),
            subuid=subuid,
            subgid=subgid,
            mapped_uid=mapped_uid,
            mapped_gid=mapped_gid,
        )
        apply_permission_plan(plan)
        if probe:
            _probe_root(writable_root, users_root=root, docker_socket=docker_socket, image_ref=image_ref)
    print(f"沙盒存储 ACL 已就绪：目录数={len(roots)} 映射组={mapped_gid} 写入探针={probe}")
    return len(roots)


def main() -> int:
    parser = argparse.ArgumentParser(description="初始化 Compose 沙盒可写存储 ACL")
    parser.add_argument("users_root", help="专门的用户数据根目录，例如 /data/users")
    parser.add_argument("--login", default=os.environ.get("GUGU_ROOTLESS_LOGIN"), help="Rootless Docker 登录用户")
    parser.add_argument("--docker-socket", default=os.environ.get("GUGU_ROOTLESS_DOCKER_SOCKET", "/run/gugu/docker.sock"))
    parser.add_argument("--image", required=True, help="已加载的沙盒镜像引用")
    parser.add_argument("--probe", action="store_true", help="应用 ACL 后用真实沙盒 UID 做写入探针")
    args = parser.parse_args()
    try:
        prepare(
            args.users_root,
            login=args.login,
            docker_socket=args.docker_socket,
            image_ref=args.image,
            probe=args.probe,
        )
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"错误：{exc}", file=os.sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
