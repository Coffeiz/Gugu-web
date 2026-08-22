"""Shell 执行后端。执行器只接受已经通过策略层授权的工作区。"""

from .local import LocalWorkspaceSandbox, ShellResult

__all__ = ["LocalWorkspaceSandbox", "ShellResult"]
