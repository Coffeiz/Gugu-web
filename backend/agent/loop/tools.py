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
# 思维笔记工具不带通用 read_/search_ 前缀，必须显式纳入，避免明明读回了数据却被
# 误判成没有观察，白白多跑复查回合。
READ_PREFIXES = ("read_", "list_", "get_", "find_", "search_")
READ_TOOL_NAMES = {"note_get", "note_search"}


def is_read_tool(name: str) -> bool:
    """返回该工具能否作为一次有效的状态观察。"""
    return name.startswith(READ_PREFIXES) or name in READ_TOOL_NAMES


def partition_tool_calls(
    tool_calls, tool_snapshot,
) -> tuple[list[tuple[int, Any, str, dict]], list[tuple[int, Any]]]:
    """为同一 provider round 的工具调用分别解析目标；交互和权限在 dispatch 时独立处理。

    Agent 通过是否在同一轮提出调用来表达并发意图。工具是否读写、是否声明
    ``parallel_safe`` 或是否可能与同轮另一调用冲突，不再由服务端预检裁决。权限、
    Schema、Shell 风险、MCP 确认和危险
    操作确认均由每次 dispatch 独立处理；这里不做跨调用冲突预检，也不预先校验 Schema。
    """
    from agent.tools.tool_contract import resolve_tool_call

    parallel: list[tuple[int, Any, str, dict]] = []
    serial: list[tuple[int, Any]] = []
    for index, call in enumerate(tool_calls or ()):
        if getattr(call, "parse_error", None):
            serial.append((index, call))
            continue
        target, arguments, error = resolve_tool_call(
            getattr(call, "name", None), getattr(call, "input", None),
        )
        tool = tool_snapshot.get(target) if error is None and tool_snapshot is not None else None
        if error is not None or tool is None or not isinstance(arguments, dict):
            serial.append((index, call))
            continue
        # 只把确实要等待用户或动态审批的单项放到交互通道；同轮普通工具仍并行。
        # Shell 用输入级声明表达本条命令是否需要危险操作确认，谓词失败时保守分流。
        requires_interaction = target in {"ask_user", "manage_mcp_servers"} or bool(
            getattr(tool, "requires_confirmation", False)
        )
        confirmation_predicate = getattr(tool, "parallel_safe_for_input", None)
        if callable(confirmation_predicate):
            try:
                requires_interaction = requires_interaction or not bool(
                    confirmation_predicate(arguments)
                )
            except Exception as exc:
                diag_log("agent.loop.tool_interaction_predicate", exc)
                requires_interaction = True
        if requires_interaction:
            serial.append((index, call))
            continue
        parallel.append((index, call, target, arguments))
    return parallel, serial


def copy_skill_state_for_parallel(skill_state: dict[str, str] | None) -> dict[str, str] | None:
    """为单个并发 dispatch 复制技能 digest 状态，避免 ContextVar 继承共享可变字典。"""
    return dict(skill_state) if skill_state is not None else None


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
    tool_call_id=None,
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
        tool_call_id=tool_call_id,
    )
    try:
        return await registry.dispatch(user_id, target, dispatch_input)
    finally:
        reset_dispatch_session(_dispatch_token)
