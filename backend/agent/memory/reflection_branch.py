"""Owner 与 IM 记忆反思共用的 append 分支执行器。"""
from __future__ import annotations

from agent.context.branch import ContextBranch
from agent.context.branch_types import BranchInput, BranchPolicy, BranchResult


async def run_reflection_branch(
    branch_input: BranchInput,
    settings,
    *,
    max_tokens: int,
    thinking: str | None = None,
    max_retries: int = 0,
) -> BranchResult:
    """统一反思分支的 ContextBranch 生命周期，领域侧只负责输入与写回。"""
    return await ContextBranch().run(
        branch_input,
        BranchPolicy(
            name="reflection",
            output_mode="json",
            max_tokens=max_tokens,
            max_retries=max_retries,
            thinking=thinking,
        ),
        settings,
    )
