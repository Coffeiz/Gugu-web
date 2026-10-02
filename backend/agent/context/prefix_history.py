"""分支前缀渲染：append_reuse 分支与主 run 逐字节对齐的统一出口。

契约（压缩与反思共同遵守，提炼自压缩的 `_branch_prefix_history`）：

- 输入是 canonical 形态的消息列表，输出是不可变 `ProviderConversation`；
  调用链必须保留该类型，不能再把 wire 消息误当 canonical 历史二次渲染；
- 渲染口径与主 run 的 render_history 完全一致（含 anthropic 路由的「消息级
  system 投影成 user」，见下方历史注释），前缀才能逐 token 对齐；
- 渲染失败回退原列表：宁可缓存 miss（无历史独立调用会多花一点），不可
  让分支调用直接失败影响业务结果。
"""
from __future__ import annotations


def render_branch_prefix(prefix: list, ai):
    """把 canonical 前缀渲染成 provider wire 快照，并保留类型边界。"""
    from agent.context.assembly.area import MessageArea
    from agent.providers import adapter_for

    adapter = adapter_for(ai)
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
