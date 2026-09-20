"""分支前缀渲染：append_reuse 分支与主 run 逐字节对齐的统一出口（PRD-LLM-27 §6.2）。

契约（压缩与反思共同遵守，提炼自压缩的 `_branch_prefix_history`）：

- 输入是 canonical 形态的消息列表（主 run 发送过的同一序列），输出是
  provider wire 形态的**普通 list**——脱离 `PromptMessages` 的 canonical
  簿记（batch 封存 / digest / sync_backing），delta 追加绝不能走 canonical
  追加路径，否则反思内容会被写进主会话事实源；
- 渲染口径与主 run 的 render_history 完全一致（含 anthropic 路由的「消息级
  system 投影成 user」，见下方历史注释），前缀才能逐 token 对齐；
- 渲染失败回退原列表：宁可缓存 miss（无历史独立调用会多花一点），不可
  让分支调用直接失败影响业务结果。
"""
from __future__ import annotations


def render_branch_prefix(prefix: list, ai) -> list:
    """把 canonical 形态前缀渲染成 provider wire 形态。"""
    try:
        from agent.providers import adapter_for

        adapter = adapter_for(ai)
        rendered = list(adapter.render_history(prefix))
        # anthropic 路由的主 run 在 render_history 之后还会把「消息级 system」投影成
        # user（见 loop_drivers.AnthropicDriver.run_round）。少了这一步，快照那类
        # system 消息的角色就和主 run 发过的不一致，前缀从那条消息起整段失配——
        # 实测同一前缀只换角色：cache_read 3840 → 384。
        from agent.llm.llm_select import use_anthropic_for

        if use_anthropic_for(ai):
            from agent.context.provider_history import render_anthropic_message_roles

            rendered = list(render_anthropic_message_roles(rendered, adapter))
        return rendered
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("agent.context.prefix_history.render", exc)
        return list(prefix)
