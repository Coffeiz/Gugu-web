"""Agent run 生命周期契约（PRD-LLM-18 LLM18-001）。

三类单一事实源的类型，供 preparation/execution/finalization 与 runner 兼容入口共享：

1. ``PreparedExecution``——准备完成后的不可变执行快照，是执行层唯一输入；
2. ``EarlyExit``——准备阶段就确定的无 LLM 终态（附件失效/配额耗尽/语音不支持）；
3. AgentEvent 流——runner 入口对 Sink 暴露的统一事件序列（tuple 形态）。

事件保持 tuple 形态（("token", str) / (ROUND_END, str) / ("final", AgentResponse)）：
这是 Web/IM 协议的事实标准，迁成 dataclass 属于 FR-RUN-02 的待确认问题，本阶段不做。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from agent.models import AgentResponse

# ── AgentEvent 流契约（FR-RUN-02）───────────────────────────────
# 事件不含用户正文之外的敏感信息；Sink 只消费事件，不得改变语义或重新执行 Agent。
# 完整事件语义表见 docs/prds/PRD-LLM-18 §2 FR-RUN-02，新增/改名事件必须同步该表。
EVENT_TOKEN = "token"
EVENT_FINAL = "final"
# 轮次结束事件名沿用 agent.interactions.events.ROUND_END（"round_end"），
# 不在此重复定义常量，避免两份事实源。

# ── EarlyExit：准备阶段即可判定的终态 ──────────────────────────
EARLY_EXIT_ATTACHMENT = "attachment_claim_failed"
EARLY_EXIT_QUOTA = "quota_exhausted"
EARLY_EXIT_VOICE = "voice_unsupported"


@dataclass(frozen=True)
class EarlyExit:
    """准备阶段确定的无 LLM 终态。

    runner 的 collect 入口直接 ``return response``，stream 入口转成
    ``("final", response)``——Sink 的形态差异只在入口体现，preparation 不感知。
    ``model_cfg`` 在语音不支持分支已 release，其他分支不涉及模型占用的对称语义
    与旧实现一致（附件/配额分支本就不 release）。
    """

    reason: str
    response: AgentResponse


@dataclass(frozen=True)
class PreparedExecution:
    """准备完成的执行快照，执行层（runner.run 消费 + 收尾）的唯一输入。

    构造完成后字段视为不可变：执行期的可变状态（流式计数、取消位、续轮标志）
    都放在事件消费层的局部变量里，不回写本对象（PRD-LLM-18 §3.2）。

    字段按收尾所需的最小面收敛：
    - 身份：session_id / is_new_session / session / snapshot（locale 取自 snapshot）
    - 模型：model_cfg / run_config（reasoning_persistence）/ use_anthropic
    - 平台策略：context_policy（收尾反思开关 allow_memory_reflection 用）
    - 执行器：runner（LLMRunner，已按 tool_names / capability_context / MCP 装配）
    - 组装产物：prepared（run_context.PreparedRun，含 provider 消息、RAG、姿态）
    - 收尾标识：user_message（id 供 finalize_run 关联）、system_prompt（Responses
      instructions 用）、session_factory（收尾短事务）、settings
    """

    session_id: int
    is_new_session: bool
    session: Any
    snapshot: dict
    system_prompt: str
    user_message: Any
    model_cfg: Any
    run_config: Any
    use_anthropic: bool
    context_policy: Any
    runner: Any
    prepared: Any
    session_factory: Callable
    settings: Any
