"""ContextBranch 的公共类型。

这里仅描述分支执行所需的上下文和结果，不包含 Memory 或会话业务字段。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


BranchName = Literal["compaction", "reflection", "knowledge"]
OutputMode = Literal["text", "json"]
# standalone：独立分支，带 session_id 时失效主会话 reasoning continuation（既有行为）；
# append_reuse：只读 sibling branch（PRD-LLM-27 §6.6），复用主会话前缀但不修改
# 主 continuation——分支响应不作为主会话下一轮的 Responses API 续接。
BranchMode = Literal["standalone", "append_reuse"]


@dataclass(frozen=True)
class BranchInput:
    """分支请求的稳定前缀和本次增量。

    history_messages 非空时走「追加式」：直接复用主会话的 canonical 消息序列，
    delta 作为末尾追加的 user 消息发送，让分支请求与主对话共享前缀以命中
    provider 的会话内缓存。history_messages 为空时走独立分支：stable_system
    为 system 参数，delta 即全部 user 输入。
    """

    stable_system: str
    delta: str = ""
    scope: str = ""
    scope_revision: str | None = None
    session_id: int | None = None
    scope_owner_id: str | int | None = None
    run_id: str | None = None
    history_messages: tuple[Any, ...] = ()
    # 追加式分支必须带上主 run 的同款工具声明：provider 把 tools 一并算进可缓存
    # 前缀，缺了它连消息部分都命中不了（实测 100% → 15%）。分支只输出文本、不消费
    # 工具调用，也不要设置 tool_choice——实测那同样会让命中失效。
    tools: tuple[Any, ...] = ()
    # 状态边界（§6.6）：append_reuse 只读复用主前缀，不得失效主会话 reasoning
    # continuation；standalone 维持既有「带 session_id 即失效」行为。
    branch_mode: BranchMode = "standalone"


@dataclass(frozen=True)
class BranchPolicy:
    """公共执行策略；业务分支只能调整这些执行参数，不能改变组装顺序。"""

    name: BranchName
    output_mode: OutputMode = "json"
    max_retries: int = 0
    max_tokens: int = 800
    thinking: str | None = None


@dataclass(frozen=True)
class BranchResult:
    """统一的 provider 分支结果和可审计元数据。"""

    ok: bool
    output: Any = None
    return_reason: str = "completed"
    provider_usage: Any = None
    attempts: int = 1
    input_fingerprint: str = ""
    output_fingerprint: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
