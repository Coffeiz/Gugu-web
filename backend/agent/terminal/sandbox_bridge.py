"""PTY 沙箱桥接契约。

PTY 的真实启动必须由 sandboxd 或等价的受控执行服务实现。本模块只定义边界，
不提供本机 Shell fallback，防止开发环境误把用户输入执行在 Web 主机上。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .pty_manager import PtyBridge, PtyHandle, PtyLaunchSpec


class SandboxPtyTransport(Protocol):
    """sandboxd 客户端实现的受控 PTY transport。"""

    async def open(self, spec: PtyLaunchSpec) -> PtyHandle: ...


@dataclass(frozen=True)
class SandboxPtyPolicy:
    """sandboxd 启动 PTY 时必须固定的安全基线。"""

    drop_all_capabilities: bool = True
    no_new_privileges: bool = True
    seccomp_default: bool = True
    docker_socket_mounted: bool = False
    host_pty_exposed: bool = False

    def validate(self) -> None:
        if not self.drop_all_capabilities:
            raise ValueError("PTY 必须 drop-all capabilities")
        if not self.no_new_privileges:
            raise ValueError("PTY 必须启用 NoNewPrivs")
        if not self.seccomp_default:
            raise ValueError("PTY 必须启用默认 seccomp")
        if self.docker_socket_mounted:
            raise ValueError("PTY 禁止挂载 Docker socket")
        if self.host_pty_exposed:
            raise ValueError("PTY 禁止暴露宿主机 PTY")


class SandboxPtyBridge:
    """校验安全基线后，把 PTY 启动委托给 sandboxd transport。"""

    def __init__(self, transport: SandboxPtyTransport | None = None, policy: SandboxPtyPolicy | None = None) -> None:
        self.transport = transport
        self.policy = policy or SandboxPtyPolicy()
        self.policy.validate()

    @classmethod
    def from_socket(cls, socket_path: str) -> "SandboxPtyBridge":
        """构造生产 transport；延迟导入避免契约模块循环依赖。"""
        from agent.sandbox.client import SandboxdPtyClient

        return cls(SandboxdPtyClient(socket_path))

    async def open(self, spec: PtyLaunchSpec) -> PtyHandle:
        self.policy.validate()
        if spec.shell_mode != "sandbox":
            raise RuntimeError("交互式 PTY 暂不支持 system 范围")
        if self.transport is None:
            raise RuntimeError("sandboxd 尚未提供交互式 PTY，未启动本机 Shell")
        return await self.transport.open(spec)


__all__ = [
    "PtyBridge", "PtyLaunchSpec", "PtyManager", "SandboxPtyBridge", "SandboxPtyPolicy",
    "SandboxPtyTransport",
]
