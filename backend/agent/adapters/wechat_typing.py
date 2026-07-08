"""微信 typing indicator 生命周期管理。

iLink 的 `sendtyping` 接口本身有超时（实测约 10s 不发就自动消失），需要保持
typing 状态就得**周期性重发**。这个模块把"start / keepalive / stop"封成一个
`TypingIndicator` 对象，调用方只在处理开始时 `await indicator.start()`、处理
结束时 `await indicator.stop()`，中间不用管。

## 与 OpenClaw `createTypingCallbacks` 的对应
| OpenClaw | 本模块 |
|----------|--------|
| `createTypingCallbacks({start, stop, keepaliveIntervalMs})` | `TypingIndicator(send_typing, ...).start() / .stop()` |
| 后台自动 keepalive 循环 | `asyncio.create_task(_keepalive_loop())` |
| `onStartError` / `onStopError` 失败静默 | `_send_typing` 抛异常时 `self._log` 吞掉 |
| ticket 为空时 start/stop 退化空操作 | 构造时 ticket 为空 → `_task` 永远是 None |

## 设计要点
1. **失败静默**：`send_typing` 任一次失败都只 log 不抛（typing 是锦上添花，不能
   拖累主流程——与 `runtime_state.set_state` 同哲学：失败时状态机退化、对话照常）
2. **可重入**：连续 start/stop 不会泄漏 task；多次 stop 安全（第一次发 OFF，
   第二次短路 return）
3. **空 ticket 短路**：`typing_ticket=""` 时 start 是 no-op、stop 也是 no-op
4. **关闭时 cancel 后台 task**：用 `asyncio.CancelledError` 安全退出循环
5. **显式 keepalive 间隔**：默认 5s（OpenClaw 默认也是 5s），可在构造时覆盖
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional

from agent.adapters.wechat_client import TYPING_OFF, TYPING_ON

# async (status: int) -> None — status 用 wechat_client.TYPING_ON/TYPING_OFF
SendTypingFn = Callable[[int], Awaitable[None]]

# 默认 keepalive 间隔（与 OpenClaw `keepaliveIntervalMs: 5000` 一致）
DEFAULT_KEEPALIVE_S = 5.0


class TypingIndicator:
    """微信 typing 状态生命周期管理：start 后后台跑 keepalive，stop 时取消并发 OFF。

    用法（worker.py）：

        ind = TypingIndicator(
            send_typing=lambda status: client.send_typing(...),
            keepalive_s=5.0,
        )
        await ind.start()   # 后台 task 开始：立即发 ON + 每 5s 重发
        try:
            ...  # 处理用户消息（run_collect 等）
        finally:
            await ind.stop()    # 取消后台 task + 发 OFF
    """

    def __init__(
        self,
        send_typing: SendTypingFn,
        *,
        keepalive_s: float = DEFAULT_KEEPALIVE_S,
        log: Optional[logging.Logger | Callable[[str], None]] = None,
    ):
        self._send_typing = send_typing
        self._keepalive_s = keepalive_s
        self._log = log or logging.getLogger(__name__)
        self._task: Optional[asyncio.Task[None]] = None

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        """启动 keepalive 后台循环：立即发一次 ON，之后每 keepalive_s 重发。"""
        if self.is_running:
            return   # 已启动，不重复起 task
        self._task = asyncio.create_task(self._keepalive_loop(), name="wechat-typing-keepalive")

    async def stop(self) -> None:
        """取消后台 keepalive task + 发一次 OFF，结束后才能再次 start。"""
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                # CancelledError 是正常取消；其他异常已在 loop 里 log 过，吞掉
                pass
        # 最后发一次 OFF——即使 keepalive task 抛了也保证 OFF 走一趟
        try:
            await self._send_typing(TYPING_OFF)
        except Exception as e:
            self._log(f"[weixin-typing] send CANCEL failed: {type(e).__name__}: {e}")

    async def _keepalive_loop(self) -> None:
        """后台循环：发 ON → 每 keepalive_s 重发一次 ON。task 被 cancel 时正常退出。"""
        try:
            await self._send_typing(TYPING_ON)   # 立即发一次
            while True:
                await asyncio.sleep(self._keepalive_s)
                try:
                    await self._send_typing(TYPING_ON)
                except Exception as e:
                    # 单次失败不影响后续 keepalive——失败只 log
                    self._log(f"[weixin-typing] keepalive TYPING_ON failed: {type(e).__name__}: {e}")
        except asyncio.CancelledError:
            # stop() 取消 → 静默退出
            raise