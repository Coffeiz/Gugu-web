"""Round 生命周期的纯决策函数（PRD-LLM-25 LLM25-006 / FR-LLM25-008）。

这里只做上下文压缩窗口与 provider 溢出恢复的纯**判定**，不做 IO、不 yield SSE、
不读数据库；本模块只处理轮次压缩与溢出恢复。普通对话没有产品级轮次/工具次数上限；
定时任务由 runner 单独限制为 100 个模型轮次和 30 次工具调用，超限交给外层重试。
"""
from __future__ import annotations

from dataclasses import dataclass

RUN_COMPACTION_KEEP_ROUNDS = 10


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
