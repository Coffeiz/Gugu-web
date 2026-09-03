"""Shell 沙盒空间计量与配额判断。

这里只提供确定性的本地目录计量，不负责拦截文件系统写入。真正的强制配额
需要由 sandboxd/文件系统层执行，避免把一次执行后的统计误当成安全边界。
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SandboxQuotaSnapshot:
    used_bytes: int
    limit_bytes: int

    @property
    def available_bytes(self) -> int:
        return max(0, self.limit_bytes - self.used_bytes)

    @property
    def exceeded(self) -> bool:
        return self.used_bytes > self.limit_bytes


def measure_directory(root: str | Path) -> int:
    """统计目录中普通文件占用的逻辑字节数，不跟随软链接。"""
    base = Path(root).expanduser().resolve(strict=True)
    if not base.is_dir():
        raise ValueError("配额根目录必须是目录")
    total = 0
    for current, dirs, files in os.walk(base, followlinks=False):
        current_path = Path(current)
        dirs[:] = [name for name in dirs if not (current_path / name).is_symlink()]
        for name in files:
            path = current_path / name
            try:
                if path.is_symlink():
                    continue
                total += path.stat(follow_symlinks=False).st_size
            except OSError:
                # 文件在统计期间被删除或权限发生变化时不伪造超额，下一次统计重试。
                continue
    return total


def snapshot_quota(root: str | Path, limit_bytes: int) -> SandboxQuotaSnapshot:
    if limit_bytes < 0:
        raise ValueError("配额不能为负数")
    return SandboxQuotaSnapshot(measure_directory(root), limit_bytes)


def can_reserve(snapshot: SandboxQuotaSnapshot, additional_bytes: int = 0) -> bool:
    if additional_bytes < 0:
        raise ValueError("预留空间不能为负数")
    return snapshot.used_bytes + additional_bytes <= snapshot.limit_bytes


def clear_sandbox_directory(root: str | Path) -> int:
    """清空用户 Shell 沙盒目录，不删除目录本身；调用方必须先过确认门。"""
    base = Path(root).expanduser().resolve(strict=True)
    if base.name != "shell" or base.parent == base or base.parent.parent == base.parent:
        raise ValueError("沙盒目录不是受支持的用户 Shell 根目录")
    removed = 0
    for child in base.iterdir():
        if child.is_symlink() or child.is_file():
            child.unlink()
        elif child.is_dir():
            shutil.rmtree(child)
        removed += 1
    return removed


def ensure_sandbox_root(root: str | Path) -> Path:
    """创建并返回受支持的用户 Shell 根目录。

    目录创建集中在这里，保证本地与 OSS 文件后端共用同一套 Shell 空间
    初始化逻辑；OSS 的对象存储不应被误当成本地执行挂载。
    """
    base = Path(root).expanduser().resolve()
    if base.name != "shell" or base.parent.name == "":
        raise ValueError("沙盒目录不是受支持的用户 Shell 根目录")
    base.mkdir(parents=True, exist_ok=True)
    # 生产部署中沙盒容器由 backend 通过 docker.sock 作为兄弟容器启动；rootless
    # docker 下沙盒进程映射到部署用户 uid，与 backend 容器的 root 不同，必须在
    # 挂载根目录上有写权限。目录属主无法跨部署环境保证一致，这里统一放开为
    # 全员可写——这是兼容性取舍：宿主机侧其他本地用户理论上可写此目录（专用
    # 单用户部署可接受）；容器侧仍受 cap-drop、只读根和挂载范围限制。多用户
    # 宿主机部署建议改用专用组/ACL 收紧。
    base.chmod(0o777)
    if not base.is_dir():
        raise ValueError("沙盒根目录不可用")
    return base
