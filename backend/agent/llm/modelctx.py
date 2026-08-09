"""把"这轮工具循环真正在跑的模型配置"透传给工具层。

工具 handler 判断"当前模型支持什么"时（比如 read_file 读视频要判断是否为
MiniMax M3），不能靠重新读 `get_settings().ai`——pool/router 场景下这轮真正
执行的模型可能和顶层静态配置不是同一个（`LLMRunner.run` 的 `model_cfg` 参数，
`pick_model()` 解析出的结果）。ContextVar 在 `create_task` 时按任务复制、同一
任务内的 await 链路共享，`_run_loop` 设一次，下游 `driver.run_round` →
`registry.dispatch` → 工具 handler 都能读到同一个 model_cfg，不同请求
（不同 asyncio task）互不影响，同 `agent.imctx`/`agent.runtime.trace` 的模式。
"""
from __future__ import annotations

from contextvars import ContextVar

_model_cfg: ContextVar[object | None] = ContextVar("model_cfg", default=None)


def set_model_cfg(ai) -> None:
    _model_cfg.set(ai)


def get_model_cfg():
    return _model_cfg.get()
