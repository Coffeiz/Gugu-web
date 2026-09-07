"""用户终端策略与生效能力计算。"""

from __future__ import annotations

from agent.sandbox.docker_runtime import sandbox_readiness


TERMINAL_MODES = frozenset({"auto", "pty_disabled", "entry_disabled"})


def configured_terminal_mode(settings) -> str:
    mode = getattr(getattr(settings, "sandbox", None), "terminal_mode", "auto")
    return mode if mode in TERMINAL_MODES else "auto"


def terminal_capabilities(settings, *, sandbox_ready: bool | None = None) -> tuple[bool, bool]:
    """返回当前沙盒是否开放终端入口和交互式 PTY。

    这是生效状态，不是配置值：沙盒未就绪时两项都必须关闭。terminal_mode
    只控制用户终端层，不会影响 Agent Shell 执行器。
    """
    sandbox = getattr(settings, "sandbox", None)
    if sandbox is None:
        return False, False
    ready = sandbox_ready
    if ready is None:
        ready, _ = sandbox_readiness(sandbox)
    if not ready:
        return False, False
    mode = configured_terminal_mode(settings)
    entry_enabled = mode != "entry_disabled"
    pty_enabled = entry_enabled and mode != "pty_disabled"
    return entry_enabled, pty_enabled
