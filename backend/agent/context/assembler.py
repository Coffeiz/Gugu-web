"""ContextBranch 的稳定输入组装器。"""
from __future__ import annotations

from .branch_types import BranchInput


def assemble_branch_user_input(branch_input: BranchInput) -> str:
    """按固定顺序组装分支 user 输入。

    system prompt 仍作为 provider 的 system 参数发送；这里仅组装 baseline、动态上下文
    和本次 delta。scope/revision 只留在审计元数据，不进入正文。空字段不创建空段，
    避免不同入口产生无意义的前缀差异。
    """
    sections: list[str] = []
    # 只有本次增量时直接返回原文，兼容已有单段 Prompt，同时避免无意义包装破坏前缀。
    if (
        branch_input.delta
        and not branch_input.baseline
        and not branch_input.dynamic_context
    ):
        return branch_input.delta
    if branch_input.baseline:
        sections.append(f"【baseline】\n{branch_input.baseline}")
    # scope / revision 仅用于审计元数据，绝不写入 provider user 输入；否则同一
    # 分支在不同 scope 下会发生前缀断裂，并把内部标识暴露给压缩/反思模型。
    if branch_input.dynamic_context:
        sections.append(f"【动态上下文】\n{branch_input.dynamic_context}")
    if branch_input.delta:
        sections.append(f"【本次增量】\n{branch_input.delta}")
    return "\n\n".join(sections)
