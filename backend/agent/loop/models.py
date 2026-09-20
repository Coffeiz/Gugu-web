"""Agent Loop 显式运行状态与交互现场类型（PRD-LLM-25 LLM25-005）。

这里只定义类型，不做 IO、不读配置；字段语义与 `_run_loop` 初始化区的局部
状态一一对应，Phase 2 起逐步替换散落的局部布尔/计数器（FR-LLM25-004）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import NamedTuple


class PendingInteraction(NamedTuple):
    """等待用户交互时暂存的调用现场。

    ``replay`` 只有破坏性工具的确认门会填：用户在界面上确认后，服务端按原参数
    重投这次调用，模型不必也不应重新调用一次。提问、预算弹窗恢复后交给模型
    继续走，没有需要重投的调用现场。
    """
    prompt_id: int
    tool_call_id: str
    tool_name: str
    replay: dict | None = None


@dataclass
class RunState:
    """一次 Agent run 的显式运行状态。

    收敛 `_run_loop` 初始化区散落的局部变量（PRD §3.3.2「初始化收敛为
    RunState」）；Phase 2 起由 round/tools/interactions 模块读写同一实例，
    取代跨闭包 nonlocal 的隐式共享。
    """

    run_id: str
    session_id: str | None = None

    # ── 轮次与预算（FR-LLM25-008：安全上限不可丢失）───────────────────────
    round_number: int = 0
    tool_call_count: int = 0
    verify_rounds: int = 0
    absolute_rounds_used: int = 0

    # ── provider / usage ─────────────────────────────────────────────────
    run_context_usage: int = 0
    hard_budget_retries: int = 0
    total_usage_out: int = 0

    # ── 守卫 ───────────────────────────────────────────────────────────────
    guard_retry_count: int = 0

    # ── 交互现场（同一时刻至多一个 pending）──────────────────────────────
    pending: PendingInteraction | None = None

    # ── 事件序号（events.EventSequencer 持有权威值，这里镜像用于诊断）────
    event_seq: int = 0

    def next_round(self) -> int:
        """进入下一轮并返回新轮号。"""
        self.round_number += 1
        return self.round_number


@dataclass
class RoundOutcome:
    """一次 provider round 的归一化结果（FR-LLM25-002）。

    `loop/rounds.py`（Phase 2）据其决定继续、暂停、核实或结束；本类型先在
    Phase 1 落位，供 round 编排迁移时复用，避免 Phase 2 再改公共类型。
    """

    text: str = ""
    tool_calls: list = field(default_factory=list)
    usage_in: int = 0
    usage_out: int = 0
    cache_tokens: int = 0
    cache_write_tokens: int = 0
    stopped_reason: str | None = None
