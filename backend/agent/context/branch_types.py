"""ContextBranch 的公共类型。

这里仅描述分支执行所需的上下文和结果，不包含 Memory 或会话业务字段。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


BranchName = Literal["compaction", "reflection", "knowledge"]
OutputMode = Literal["text", "json"]


@dataclass(frozen=True)
class BranchInput:
    """分支请求的稳定前缀和本次增量。"""

    stable_system: str
    baseline: str = ""
    delta: str = ""
    dynamic_context: str = ""
    scope: str = ""
    scope_revision: str | None = None
    session_id: int | None = None
    run_id: str | None = None


@dataclass(frozen=True)
class BranchPolicy:
    """公共执行策略；业务分支只能调整这些执行参数，不能改变组装顺序。"""

    name: BranchName
    output_mode: OutputMode = "json"
    max_retries: int = 0
    max_tokens: int = 800
    temperature: float = 0.3
    thinking: str | None = None
    preserve_prefix: bool = True


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
