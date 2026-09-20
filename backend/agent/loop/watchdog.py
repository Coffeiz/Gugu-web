"""Agent run 诊断摘要。

这里记录的是排查循环行为所需的结构信息，不记录用户正文、工具参数值、命令或凭据。
详细正文仍由既有的受限诊断出口/LoopScope 负责；本模块只做 best-effort 日志，日志失败
不能影响 Agent 主流程。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Iterable

from agent.security.logsafe import fingerprint


_log = logging.getLogger("agent.traj")
_SAFE_TOOL_NAME = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")


def _trace_id() -> str | None:
    try:
        from agent.runtime.trace import get_trace

        return get_trace()
    except Exception:
        return None


def _input_fingerprint(value: Any) -> str:
    """只返回参数结构的不可逆指纹，不把值写进日志。"""
    try:
        encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    except Exception:
        encoded = type(value).__name__
    return fingerprint(encoded)


def _safe_tool_name(value: Any) -> str:
    """工具名正常时原样保留；协议污染时只留指纹，避免回显模型拼入的正文。"""
    name = str(value or "")
    if _SAFE_TOOL_NAME.fullmatch(name):
        return name
    return f"invalid:{fingerprint(name)}" if name else "(empty)"


def _emit(event: str, *, run_id: str, round_number: int | None = None, **fields: Any) -> None:
    """以单行 JSON 写入既有轨迹日志；任何日志异常都静默吞掉。"""
    try:
        record: dict[str, Any] = {
            "t": "loop",
            "event": event,
            "run": run_id,
        }
        if round_number is not None:
            record["round"] = round_number
        trace_id = _trace_id()
        if trace_id:
            record["trace"] = trace_id
        record.update(fields)
        _log.info(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
    except Exception:
        pass


def record_round_result(
    *,
    run_id: str,
    round_number: int,
    tool_calls: Iterable[Any] = (),
    requires_tools: bool | None,
    verify_mode: bool,
    goal_mode: bool,
    unlimited_mode: bool,
    task_rounds: int,
    verify_rounds: int,
    tool_calls_used: int,
) -> None:
    """记录一轮 provider 返回的工具摘要。"""
    calls = list(tool_calls or ())
    names = [_safe_tool_name(getattr(call, "name", "")) for call in calls]
    inputs = [getattr(call, "input", None) for call in calls]
    _emit(
        "round_result",
        run_id=run_id,
        round_number=round_number,
        tools=names,
        tool_count=len(calls),
        tool_input_fp=_input_fingerprint(inputs) if calls else "",
        requires_tools=requires_tools,
        verify=verify_mode,
        goal=goal_mode,
        unlimited=unlimited_mode,
        task_rounds=task_rounds,
        verify_rounds=verify_rounds,
        tool_calls_used=tool_calls_used,
    )


def record_provider_retry(*, run_id: str, round_number: int, attempt: Any, error_kind: Any) -> None:
    """记录 provider 的安全重试标签，不记录异常正文。"""
    _emit(
        "provider_retry",
        run_id=run_id,
        round_number=round_number,
        attempt=int(attempt or 0),
        error_kind=str(error_kind or "unknown")[:80],
    )


def record_stop(*, run_id: str, round_number: int, reason: str, **fields: Any) -> None:
    """记录一次主动收束/熔断/安全上限停止。"""
    _emit("stop", run_id=run_id, round_number=round_number, reason=reason, **fields)


__all__ = ["record_round_result", "record_provider_retry", "record_stop"]
