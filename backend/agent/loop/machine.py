"""`agent.loop.runner` 的兼容导入层，保留旧测试/诊断脚本入口。"""
from __future__ import annotations

from agent import core as _core
from agent.loop.runner import (
    _allow_tool_images,
    _log_tool_batch_observation,
    _llm_diagnostic_context,
    _llm_diagnostic_tag,
    _record_provider_round_diagnostic,
    run_loop,
)

__all__ = ["run_loop"]
