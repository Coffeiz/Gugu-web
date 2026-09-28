"""工具生命周期编排（PRD-LLM-25 LLM25-008 / FR-LLM25-003）。

这里聚集工具批次的纯判定与受控执行入口：verify 信号、
结果负载规范和 dispatch 会话上下文。registry/Schema/确认门事实源仍在
`agent.tools` 与 `agent.interactions.confirmations`，本模块不复制。
"""
from __future__ import annotations

import json
from typing import Any

from agent.tools import registry
from app.core.redaction import diag_log

# 查询工具命名前缀：核实轮必须真调这类工具，不许凭印象说"确认了"。
# 思维笔记的只读工具不带通用 read_/search_ 前缀，必须显式纳入，避免明明读回了
# 数据却被误判成没有观察，白白多跑复查回合。
READ_PREFIXES = ("read_", "list_", "get_", "find_", "search_")
READ_TOOL_NAMES = {"note_get", "note_search"}


def is_read_tool(name: str) -> bool:
    """返回该工具能否作为一次有效的状态观察。"""
    return name.startswith(READ_PREFIXES) or name in READ_TOOL_NAMES


def call_requires_verification(tool_name: str, tool_input: Any, tool_snapshot, mutating_tools: set) -> bool:
    """判断成功调用是否需要进入本地状态复查（verify 信号）。

    工具可以显式覆盖复查策略；未覆盖时，兼容既有工具契约的 mutates 语义。
    """
    tool = tool_snapshot.get(tool_name) if tool_snapshot is not None else None
    override = getattr(tool, "verify_after_call", None)
    if override is not None:
        if callable(override):
            try:
                return bool(override(tool_input if isinstance(tool_input, dict) else {}))
            except Exception as exc:
                diag_log("agent.core.tool_verification_predicate", exc)
                return True
        return bool(override)
    if tool_name not in mutating_tools:
        return False
    predicate = getattr(tool, "mutates_for_input", None)
    if callable(predicate):
        try:
            return bool(predicate(tool_input if isinstance(tool_input, dict) else {}))
        except Exception as exc:
            # 元数据判断失败不能把一次调用误当成只读；保守按工具级 mutates 处理。
            diag_log("agent.core.tool_mutation_predicate", exc)
    return True


def call_observes(tool_name: str, tool_input: Any, tool_snapshot) -> bool:
    """判断一次具体调用是否提供了复查所需的状态观察结果。"""
    tool = tool_snapshot.get(tool_name) if tool_snapshot is not None else None
    predicate = getattr(tool, "observes_for_input", None)
    if callable(predicate):
        try:
            return bool(predicate(tool_input if isinstance(tool_input, dict) else {}))
        except Exception as exc:
            # 观察声明异常时不能假定状态已核实，交给既有复查预算处理。
            diag_log("agent.core.tool_observation_predicate", exc)
            return False
    return is_read_tool(tool_name)


def tool_result_payload(result) -> dict:
    """把工具返回统一成 dict 负载（字符串 JSON 尽量解析，失败按纯文本）。"""
    if isinstance(result, dict):
        return result
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
        except (TypeError, ValueError):
            return {"text": result}
        return parsed if isinstance(parsed, dict) else {"result": parsed}
    return {"result": result}


def pending_tool_signal(status: str, result, pending, *, verify: bool) -> dict:
    """交互中断（用户取消/超时）时，给工具气泡补的终态事件负载。

    进交互门时运行侧已经发过一条 ``status="waiting"`` 的 tool_done，不补终态的话
    气泡会永远停在「等待回复」——实时如此，刷新后也一样，因为展示时间线里存的
    就是这个状态。
    """
    payload = {
        "tool_call_id": pending.tool_call_id,
        "name": pending.tool_name,
        "status": status,
        "verify": verify,
    }
    if result is not None:
        payload["result"] = result
    return payload


async def dispatch_in_session(
    user_id, target, dispatch_input, *, session_id, session, run_id, tool_snapshot, skill_state,
):
    """带 dispatch 会话上下文执行一次工具调用（原 core._dispatch_in_session）。

    首次调用与用户确认后重投必须走同一条路径：确认门授权判定、身份绑定和技能
    状态都取自 dispatch 会话上下文，两处各写一遍早晚会漂移（重投时参数、目标
    与首次完全一致是这个不变量的前提）。
    """
    from agent.tools.base import set_dispatch_session, reset_dispatch_session

    _dispatch_token = set_dispatch_session(
        session_id, session, run_id,
        tool_snapshot=tool_snapshot,
        skill_state=skill_state,
    )
    try:
        return await registry.dispatch(user_id, target, dispatch_input)
    finally:
        reset_dispatch_session(_dispatch_token)
