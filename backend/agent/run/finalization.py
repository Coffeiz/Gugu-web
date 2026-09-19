"""统一 run 收尾门面（PRD-LLM-18 LLM18-004，FR-RUN-04）。

正常完成、取消、错误、Sink 发送失败等所有出口都经过同一套可判定收尾：

- final 事件不早于持久化：``finalize_agent_run`` 先落 canonical history/用量
  （run_finalize.finalize_run），再调度标题/摘要，最后才执行渠道广播
  （经 ``publish_assistant`` 注入——Web/IM 的发送形态差异在此收敛）；
- collect/stream 曾各写一份收尾并发生漂移（stream 漏 display_timeline、
  round_texts 出站清洗不一致），本模块是它们的合并终态；
- 渠道广播失败不回滚持久化，也不得把失败 Run 标成成功：广播异常被吞掉
  仅影响其他端实时刷新，落库事实已成立（与旧实现语义一致）。
"""
from __future__ import annotations

from typing import Callable

from agent.capabilities.defaults import SYSTEM_MEMORY_ENABLED
from agent.context.canonical_tool_history import persistable_canonical_batch_records
from agent.memory.reflection_input import build_reflection_input
from agent.security import sanitize
from agent.run.contract import PreparedExecution
from agent.run.execution import RunOutcome


async def finalize_agent_run(
    req,
    exec_: PreparedExecution,
    outcome: RunOutcome,
    *,
    publish_assistant: Callable | None = None,
) -> bool:
    """持久化 + 标题/摘要调度 + 渠道广播 + 反思；返回 im_used_tools 供响应装配。

    仅在 outcome 未中断（无错误、未取消）时执行；调用方在此之前自行处理
    取消/错误的终态响应。
    """
    from agent.context.run_finalize import finalize_run

    user_id = req.user_id
    session_id = exec_.session_id
    settings = exec_.settings
    prepared = exec_.prepared
    messages = prepared.anthr_messages if exec_.use_anthropic else prepared.oa_messages
    initial_len = prepared.anthr_initial_len if exec_.use_anthropic else prepared.oa_initial_len
    text = outcome.text

    # 出站兜底清洗：正文与逐轮文本同一口径（抹 tool_id 噪声、拦系统提示词泄露、
    # 删白名单外 emoji），发给用户/持久化之前执行。清洗结果回写 outcome，
    # 入口据此装配最终 AgentResponse（collect/stream 同一文本口径）。
    from agent.outbound import sanitize_outbound
    text = sanitize_outbound(text)
    text = sanitize.strip_disallowed_emoji(text)
    round_texts = []
    for round_text in outcome.round_texts:
        cleaned = sanitize.strip_disallowed_emoji(sanitize_outbound(round_text))
        if cleaned.strip():
            round_texts.append(cleaned)
    outcome.text = text
    outcome.round_texts = round_texts

    # 逐轮展示时间线。canonical assistant.content 兼容旧历史，但刷新回放必须
    # 依赖 display_timeline，否则多轮输出只剩最后一轮。
    # 优先用消费层按流式顺序记录的统一时间线（assistant 轮次 + tool 项交错，
    # 与 gateway/web.py 的构造语义一致）——只存正文轮次会让刷新后的工具气泡
    # 退化到兼容 toolEvents 通道（按 canonical 行 id 排序），整体跳到该轮正文前面。
    display_timeline = outcome.display_timeline_items or [
        {"kind": "assistant", "text": round_text}
        for round_text in round_texts
    ]

    await finalize_run(
        session_factory=exec_.session_factory,
        session_id=session_id,
        user_id=user_id,
        settings=settings,
        model_cfg=exec_.model_cfg,
        rag_context=prepared.rag_context,
        messages=messages,
        initial_len=initial_len,
        stance_text=prepared.stance_to_persist,
        user_message_id=getattr(exec_.user_message, "id", None),
        canonical_batches=persistable_canonical_batch_records(messages),
        text=text,
        display_timeline=display_timeline or None,
        files=outcome.files,
        tokens_in=outcome.tokens_in,
        tokens_out=outcome.tokens_out,
        cache_read=outcome.cache_read,
        cache_write=outcome.cache_write,
        compaction_applied=outcome.compaction_applied,
    )

    # 新会话标题：移出关键路径，后台生成（会话已有首句截断做临时标题，好了再异步升级+推事件）。
    if exec_.is_new_session and text:
        from agent.conversation.session_metadata import schedule_title
        schedule_title(
            user_id, session_id, req.message, text, settings, exec_.use_anthropic,
            locale=getattr(req, "locale", None) or (exec_.snapshot or {}).get("locale"),
        )
    # 会话「一句话总结」：新会话先出一版，之后每 ~6 条刷新（跟着话题走）；供 search_conversations + 续接桥
    if text:
        from agent.conversation.session_metadata import schedule_summary
        schedule_summary(user_id, session_id, exec_.is_new_session, settings, exec_.use_anthropic)

    # 渠道广播（Sink 发送）：形态差异经 publish_assistant 注入，持久化已在之前完成。
    if publish_assistant is not None:
        await publish_assistant(text=text, round_texts=round_texts, files=outcome.files)

    # 对话后反思（fire-and-forget）。用「工具轮次让 messages 变长」当「咕咕动作了」代理，
    # 这样「嗯」确认后真建改东西的轮也会反思（openai 路径无此代理、回落到 user_msg 判，可接受）。
    im_used_tools = False
    if SYSTEM_MEMORY_ENABLED and text and exec_.context_policy.allow_memory_reflection:
        from agent.memory import reflection
        im_used_tools = exec_.use_anthropic and len(messages) > initial_len
        reflect_message, reflect_reply = build_reflection_input(
            req, messages, initial_len, text
        )
        if reflect_reply:
            reflection.schedule(user_id, req.user_name, reflect_message, reflect_reply, settings,
                                used_tools=im_used_tools, session_id=session_id,
                                group_mode=bool(req.chat_id and req.source != "web"))

    return im_used_tools
