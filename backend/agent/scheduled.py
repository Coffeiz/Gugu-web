"""定时任务专用 Agent runner 策略。"""
from __future__ import annotations

from agent.core import LLMRunner

SCHEDULED_MAX_TOOL_CALLS = 30
SCHEDULED_MAX_ROUNDS = 100


class ScheduledLLMRunner(LLMRunner):
    """定时任务最多执行 100 个模型轮次、调用 30 次工具；超限交由外层重试。"""

    tool_call_limit_per_run = SCHEDULED_MAX_TOOL_CALLS
    fail_on_tool_call_limit = True
    round_limit_per_run = SCHEDULED_MAX_ROUNDS

    def __init__(self, tool_names, settings, capability_context=None, locale: str | None = None,
                 dynamic_tools=None):
        super().__init__(tool_names, settings, capability_context=capability_context,
                         locale=locale, dynamic_tools=dynamic_tools)
