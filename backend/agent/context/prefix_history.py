"""分支前缀渲染：append_reuse 分支与主 run 逐字节对齐的统一出口。

契约（压缩与反思共同遵守，提炼自压缩的 `_branch_prefix_history`）：

- 输入是 canonical Area/列表或已有 wire 投影，输出是不可变 `ProviderConversation`；
  调用链必须保留该类型，不能再把 wire 消息误当 canonical 历史二次渲染；
- 渲染口径与主 run 的 render_history 完全一致（含 anthropic 路由的「消息级
  system 投影成 user」，见下方历史注释），前缀才能逐 token 对齐；
- 投影错误直接交给分支错误处理，不以回退掩盖前缀失配。
"""
from __future__ import annotations


def render_branch_prefix(prefix, ai):
    """仅投影 canonical 输入；已有 wire 快照保持消息与边界不变。"""
    from agent.context.assembly.area import MessageArea
    from agent.context.provider_conversation import ProviderConversation
    from agent.providers import adapter_for

    adapter = adapter_for(ai)
    if isinstance(prefix, ProviderConversation):
        rendered = prefix
    elif isinstance(prefix, MessageArea):
        rendered = prefix.provider_projection()
    else:
        area = MessageArea.from_canonical_messages(
            prefix, render_options={"api_format": adapter.protocol_format(ai)},
        )
        rendered = area.provider_projection()
    # 主 Anthropic run 还会把消息级 system 映射成 user；这个转换属于最终
    # provider projection，完成后必须以 ProviderConversation 传递，不能降成 list。
    from agent.llm.llm_select import use_anthropic_for

    if use_anthropic_for(ai):
        from agent.context.provider_history import render_anthropic_message_roles

        rendered = render_anthropic_message_roles(rendered, adapter)
    return rendered
