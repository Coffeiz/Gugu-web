"""定时任务专用 Agent runner 策略。

定时任务没有用户在场等待交互的能力，因此使用独立预算；Web/IM 仍直接使用
``agent.core.LLMRunner``，不共享这些策略值。
"""
from __future__ import annotations

from agent.core import LLMRunner

SCHEDULED_MAX_ROUNDS: int | None = None  # 外层 run 控制重试次数，单次 AgentLoop 不限模型轮次。
SCHEDULED_MAX_TOOL_CALLS = 30


class ScheduledLLMRunner(LLMRunner):
    """定时任务达到预算时直接返回失败事件，由外层自动重试或投递失败报告。"""

    def __init__(self, tool_names, settings, capability_context=None, locale: str | None = None):
        super().__init__(
            tool_names,
            settings,
            capability_context=capability_context,
            locale=locale,
            max_rounds=SCHEDULED_MAX_ROUNDS,
            max_tool_calls=SCHEDULED_MAX_TOOL_CALLS,
            max_verify_rounds=None,
            max_verify_cycles=None,
            stop_on_budget=True,
        )
