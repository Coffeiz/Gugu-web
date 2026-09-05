"""把"这轮工具循环真正在跑的模型配置"透传给工具层。

工具 handler 判断"当前模型支持什么"时（比如 read_file 读视频要判断是否为
MiniMax M3），不能靠重新读 `get_settings().ai`——pool/router 场景下这轮真正
执行的模型可能和顶层静态配置不是同一个（`LLMRunner.run` 的 `model_cfg` 参数，
`pick_model()` 解析出的结果）。ContextVar 在 `create_task` 时按任务复制、同一
任务内的 await 链路共享，`_run_loop` 设一次，下游 `driver.run_round` →
`registry.dispatch` → 工具 handler 都能读到同一个 model_cfg，不同请求
（不同 asyncio task）互不影响，同 `agent.im.imctx`/`agent.runtime.trace` 的模式。
"""
from __future__ import annotations

import logging
from contextvars import ContextVar
from dataclasses import dataclass

_model_cfg: ContextVar[object | None] = ContextVar("model_cfg", default=None)
_user_scope: ContextVar[bool] = ContextVar("modelctx_user_scope", default=False)


@dataclass(frozen=True)
class UsageContext:
    """当前用户链路的用量归属。后台派生任务会继承父任务的上下文。"""

    user_id: object
    session_id: int | None = None


_usage_context: ContextVar[UsageContext | None] = ContextVar(
    "modelctx_usage_context", default=None
)

logger = logging.getLogger("agent.modelctx")


def set_model_cfg(ai) -> None:
    _model_cfg.set(ai)


def get_model_cfg():
    return _model_cfg.get()


def set_usage_context(user_id, session_id: int | None = None) -> None:
    """绑定当前用户链路，供非对话 provider 调用统一记录用量。"""
    _usage_context.set(UsageContext(user_id=user_id, session_id=session_id))


def get_usage_context() -> UsageContext | None:
    return _usage_context.get()


def mark_user_scope() -> None:
    """标记当前上下文为「用户链路」：用户会触发的 LLM 调用都不允许静默回落平台预设。

    Web/IM/定时任务三个入口在解析 BYOK 前调用；create_task 派生的后台任务
    （反思、总结、压缩、问候语）自动继承，哨兵因此在整条链路生效。
    """
    _user_scope.set(True)


def effective_ai(settings):
    """用户链路统一读模型配置的入口：优先当前上下文绑定的模型（BYOK 解析结果），
    无绑定时回落平台预设。

    用户链路里未绑定就走到兜底，说明新调用点漏接 BYOK 绑定——打哨兵日志让它在
    日志里现形，而不是像过去那样静默烧平台配额（历史 bug：定时任务/反思/压缩
    绕过 BYOK，直到上游 429 insufficient_quota 才暴露）。
    """
    bound = _model_cfg.get()
    if bound is not None:
        return bound
    if _user_scope.get():
        logger.warning(
            "modelctx 兜底哨兵：用户链路 LLM 调用未绑定用户模型，回落平台预设 "
            "(settings.ai)。新调用点应经 resolve_run_config_for_user + set_model_cfg 绑定。")
    return settings.ai
