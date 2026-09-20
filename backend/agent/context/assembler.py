"""ContextBranch 的稳定输入组装器。"""
from __future__ import annotations

from .branch_types import BranchInput


def assemble_branch_user_input(branch_input: BranchInput) -> str:
    """返回分支的 user 输入正文。

    system prompt 仍作为 provider 的 system 参数发送；scope/revision 只留在
    审计元数据，不进入正文——否则同一分支在不同 scope 下会发生前缀断裂，并把
    内部标识暴露给压缩/反思模型。历史消息（追加式）由 complete_messages 单独
    处理，不经过这里。
    """
    return branch_input.delta
