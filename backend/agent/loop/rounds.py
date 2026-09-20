"""Round 生命周期的纯决策函数（PRD-LLM-25 LLM25-006 / FR-LLM25-008）。

这里只做预算与轮次的状态**判定**，不做 IO、不 yield SSE、不读数据库；
`core._run_loop` 把判定结果转成对应的状态转移（弹窗、收尾、继续）。
绝对轮次安全上限在任何模式下都不可解除（FR-LLM25-008）。
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

RUN_COMPACTION_KEEP_ROUNDS = 10


class RoundBudgetAction(str, Enum):
    CONTINUE = "continue"            # 允许进入下一轮
    ABSOLUTE_LIMIT = "absolute_limit"  # 绝对轮次安全上限（不可解除）
    VERIFY_LIMIT = "verify_limit"    # 核实轮达到业务封顶（弹窗可解除）
    TASK_LIMIT = "task_limit"        # 普通任务轮达到业务封顶（弹窗可解除）


def round_budget_action(
    *,
    round_number: int,
    verify_mode: bool,
    task_rounds: int,
    verify_rounds: int,
    unlimited_mode: bool,
    max_rounds: int | None,
    max_verify_rounds: int | None,
    max_absolute_rounds: int,
) -> RoundBudgetAction:
    """判定当前应执行的轮次预算动作；与原 `_run_loop` 循环头逐条对应。"""
    if round_number >= max_absolute_rounds:
        return RoundBudgetAction.ABSOLUTE_LIMIT
    if verify_mode:
        if (not unlimited_mode
                and max_verify_rounds is not None
                and verify_rounds >= max_verify_rounds):
            return RoundBudgetAction.VERIFY_LIMIT
        return RoundBudgetAction.CONTINUE
    if not unlimited_mode and max_rounds is not None and task_rounds >= max_rounds:
        return RoundBudgetAction.TASK_LIMIT
    return RoundBudgetAction.CONTINUE


def usage_compaction_due(
    *,
    run_context_usage: int,
    context_tokens: int | None,
    no_progress: bool = False,
) -> bool:
    """provider usage 达到 90% 观察线时触发 90% 压缩（原 `usage_compaction_due` 闭包）。

    90% 观察线只在 provider usage 层维护一份语义；阈值取
    `context.compress_conv.AUTO_COMPACTION_RATIO`，预算算法本身归 context 模块。
    """
    from agent.context.compress_conv import AUTO_COMPACTION_RATIO

    tokens = max(1, int(context_tokens or 0))
    return run_context_usage >= int(tokens * AUTO_COMPACTION_RATIO) and not no_progress


def rolling_compaction_start_index(
    round_starts: list[tuple[int, int]],
    current_round: int,
    keep_rounds: int = RUN_COMPACTION_KEEP_ROUNDS,
) -> int | None:
    """返回保留最近完整执行轮次的 history 起点。

    压缩发生在当前 provider round 返回后、该轮结果写入 history 前，因此窗口包含
    最近 ``keep_rounds`` 个已完成轮次；当前用户消息由独立锚点保留。
    """
    target_round = max(1, int(current_round) - max(1, int(keep_rounds)))
    return next(
        (index for round_number, index in round_starts if round_number == target_round),
        None,
    )


def remap_round_start_indices(
    round_starts: list[tuple[int, int]],
    protected_start_index: int,
    protected_source_start_index: int,
) -> list[tuple[int, int]]:
    """按压缩后实际保留的 history 后缀重映射 round 起点。"""
    return [
        (round_number, protected_start_index + (source_index - protected_source_start_index))
        for round_number, source_index in round_starts
        if source_index >= protected_source_start_index
    ]


@dataclass(frozen=True)
class OverflowRecoveryPlan:
    """provider overflow 后的一次受控恢复计划（FR-LLM25-008）。"""

    should_retry: bool
    reason: str  # "compaction" / "deterministic_fallback" / "exhausted"


def overflow_recovery_plan(*, hard_budget_retries: int, compaction_succeeded: bool, fallback_succeeded: bool) -> OverflowRecoveryPlan:
    """按「先摘要压缩、再确定性裁切、均失败则明确收尾」给出恢复计划。

    每条路径最多执行一次（hard_budget_retries 门）；调用方据此递增计数并
    回退当前 round 的轮次计数。
    """
    if hard_budget_retries >= 1:
        return OverflowRecoveryPlan(False, "exhausted")
    if compaction_succeeded:
        return OverflowRecoveryPlan(True, "compaction")
    if fallback_succeeded:
        return OverflowRecoveryPlan(True, "deterministic_fallback")
    return OverflowRecoveryPlan(False, "exhausted")


def retry_rounds_delta(verify_mode: bool) -> tuple[int, int]:
    """溢出恢复重试当前 round 时，被扣减的轮次计数增量：(verify_delta, task_delta)。"""
    return (-1, 0) if verify_mode else (0, -1)
