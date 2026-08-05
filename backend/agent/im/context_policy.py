"""IM 上下文范围策略。

这里仅回答“当前请求能加载哪一类上下文”，不负责实际读取 memory、项目或文件，
也不负责选择模型和执行工具，避免权限规则散落在不同 Loop 中。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

from agent.models import AgentRequest

IM_SOURCES: Tuple[str, ...] = ("feishu", "qq", "wechat")


@dataclass(frozen=True)
class ImContextPolicy:
    is_im: bool
    restricted: bool
    load_owner_context: bool
    allow_continuity_bridge: bool
    allow_memory_reflection: bool


def policy_for(request: AgentRequest) -> ImContextPolicy:
    """根据显式 IM 角色生成上下文策略。

    Web 请求不是 IM，不受 member/unknown 规则影响；IM 的 member/unknown
    永远走受限策略，不能因为缺少角色字段而默认升级为 owner。
    """
    is_im = request.source in IM_SOURCES
    role = request.actor_context.role if request.actor_context else request.im_role
    restricted = is_im and role in {"member", "unknown"}
    return ImContextPolicy(
        is_im=is_im,
        restricted=restricted,
        load_owner_context=not restricted,
        allow_continuity_bridge=is_im and not restricted,
        allow_memory_reflection=not restricted,
    )
