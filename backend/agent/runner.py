"""Agent run 入口：collect（攒整段）与 stream（逐字流）两个 Sink 适配层。

PRD-LLM-18 起，两条入口共享同一套生命周期（`agent/run/` 包）：

- `agent/run/preparation.py` 的 `prepare_agent_run`——第一段准备（唯一实现）；
- `agent/run/execution.py` 的 `consume_agent_events`——事件流消费（唯一实现），
  CollectSink / WebStreamSink 两种 Sink 形态；
- `agent/run/finalization.py` 的 `finalize_agent_run`——统一收尾门（持久化先于
  任何渠道广播），渠道发送差异经 ``publish_assistant`` 回调注入。

本文件只保留：公共入口（session 串行门 + EarlyExit/取消转换 + 渠道广播闭包）、
能力装配 helper 的兼容再导出（web.py / scheduled_execution / 测试按旧路径导入）、
`_collect()` 兼容包装（scheduled_execution 消费的旧 tuple 契约）。

会话历史/持久化/反思与 web 同口径：按 session_id 找/建会话、读历史窗口、存
用户+回复消息、对话后反思。session_id 由 worker 按平台用户从 Redis 取（续聊
不断），见 worker._im_session_*。
"""
from __future__ import annotations
from typing import AsyncIterator, Tuple

from agent.context import compress_conv
from agent.conversation.session_metadata import schedule_summary, schedule_title  # 兼容再导出（生命周期钩子测试断言）
from agent.models import AgentRequest, AgentResponse
from agent.run.contract import EarlyExit
from agent.run.execution import (
    CollectSink,
    RunOutcome,
    WebStreamSink,
    cancelled_response,
    consume_agent_events,
)
from agent.run.finalization import finalize_agent_run
from agent.run.preparation import (   # 兼容再导出（web.py/scheduled_execution/测试）
    _apply_capability_context,
    _capability_context,
    _filter_shell_tool,
    _load_mcp_tools,
    _pin_session_user_skill_metadata,
    _session_user_skill_metadata,
    prepare_agent_run,
)


async def _run_collect_unlocked(
    req: AgentRequest, *, on_interaction=None, on_tool_event=None, on_round=None
) -> AgentResponse:
    """共享准备 → 跑工具循环 → 攒完整回复 + 存盘 + 反思。"""
    exec_ = await prepare_agent_run(req, non_streaming=True)
    if isinstance(exec_, EarlyExit):
        return exec_.response
    session_id = exec_.session_id

    async def _publish_assistant(*, text: str, round_texts: list, files: list) -> None:
        # 推第二次：咕咕的回复（用户消息已在生成前先推过，这里只补助手消息，
        # 网页就「先看到我发的、再看到回答」，而不是一轮结束一次性蹦出来）。
        # IM 分轮发送语义：逐轮多条 assistant 消息，最后一条带文件。
        try:
            from app.core import events as _evmod
            assistant_rounds = [
                {"role": "assistant", "text": round_text}
                for round_text in round_texts
            ]
            if not assistant_rounds and text:
                assistant_rounds = [{"role": "assistant", "text": text}]
            if assistant_rounds or files:
                appended = [
                    {**item, "files": files or None}
                    if index == len(assistant_rounds) - 1 else item
                    for index, item in enumerate(assistant_rounds)
                ]
                if not appended:
                    appended = [{"role": "assistant", "text": "", "files": files or None}]
                await _evmod.publish(req.user_id, "sessions", session_id=session_id,
                                     appended=appended)
            else:
                await _evmod.publish(req.user_id, "sessions", session_id=session_id)  # 至少 bump 列表
        except Exception:
            pass

    outcome = RunOutcome()
    gen = exec_.runner.run(
        req.user_id,
        # Responses 不把 system 消息放进 input；稳定 system prompt 必须进入
        # instructions，否则人格、规则和工具行为约束都会丢失。
        exec_.system_prompt,
        exec_.prepared.anthr_messages if exec_.use_anthropic else exec_.prepared.oa_messages,
        use_anthropic=exec_.use_anthropic,
        model_cfg=exec_.model_cfg,
        session_id=session_id,
        session=exec_.session,
        on_interaction=on_interaction,
        reasoning_policy=exec_.run_config.reasoning_persistence,
        state_session_factory=exec_.session_factory,
    )
    try:
        async for _ in consume_agent_events(
            gen, model_cfg=exec_.model_cfg, outcome=outcome,
            sink=CollectSink(on_tool_event=on_tool_event, on_round=on_round),
        ):
            pass
    finally:
        from agent.llm.llm_select import release as _release_model
        _release_model(exec_.model_cfg)   # least_loaded：请求结束减在途计数（其他方式 no-op）

    # 用户中途「算了」：网关已回「先不继续啦」，这里不再补发/不入历史/不反思（已执行的工具效果保留）
    if outcome.cancelled:
        return cancelled_response(outcome, session_id)

    # 生成失败：错误文案不入历史/不反思，直接以 errored 终态返回
    if outcome.errored:
        return AgentResponse(text=outcome.text, round_texts=list(outcome.round_texts),
                             session_id=session_id, tokens_in=outcome.tokens_in, tokens_out=outcome.tokens_out,
                             cache_read=outcome.cache_read, cache_write=outcome.cache_write,
                             files=outcome.files, errored=True, error_info=outcome.error_info,
                             used_tools=False,
                             interactions=outcome.interactions,
                             tool_events=outcome.tool_events,
                             compaction_applied=outcome.compaction_applied)

    im_used_tools = await finalize_agent_run(
        req, exec_, outcome, publish_assistant=_publish_assistant,
    )

    return AgentResponse(text=outcome.text, round_texts=list(outcome.round_texts),
                         session_id=session_id, tokens_in=outcome.tokens_in, tokens_out=outcome.tokens_out,
                         cache_read=outcome.cache_read, cache_write=outcome.cache_write,
                         files=outcome.files, errored=outcome.errored, error_info=outcome.error_info,
                         used_tools=im_used_tools,
                         interactions=outcome.interactions,
                         tool_events=outcome.tool_events,
                         compaction_applied=outcome.compaction_applied)


async def run_collect(
    req: AgentRequest, *, on_interaction=None, on_tool_event=None, on_round=None
) -> AgentResponse:
    """同一 session 串行生成；不同 session 仍可并行。"""
    async with compress_conv.session_run_gate(req):
        return await _run_collect_unlocked(
            req, on_interaction=on_interaction, on_tool_event=on_tool_event,
            on_round=on_round,
        )


# ── 流式版本（飞书 send_text_stream 用，2026-07-09 接入）──────────────────────
# run_collect 的"流式"变体：与 collect 共享同一套准备/消费/收尾，差别只在 Sink
# 形态——WebStreamSink 逐字外发 token 与轮结束，让飞书 IM 端能实时 patch 卡片
# （参见 feishu.py send_text_stream）。
#
# Yield 类型（call 端用 isinstance 区分）：
#   ("token", str)            — 已过 StreamSanitizer 清洗的逐字片段
#   (ROUND_END, str)          — 一轮正文结束（IM 分轮发送）
#   ("final", AgentResponse)  — 生成结束，含完整 text/files/cancelled/session_id/tokens
#                                持久化 / 反思 / 压缩跟 run_collect 完全一致
async def _run_stream_unlocked(
    req: AgentRequest,
    *,
    on_interaction=None,
    on_tool_event=None,
) -> AsyncIterator[tuple[str, object]]:
    """共享准备 → 逐字 yield token + 轮结束 + 末尾 yield AgentResponse。"""
    exec_ = await prepare_agent_run(req, non_streaming=False)
    if isinstance(exec_, EarlyExit):
        yield ("final", exec_.response)
        return
    session_id = exec_.session_id

    async def _publish_assistant(*, text: str, round_texts: list, files: list) -> None:
        try:
            from app.core import events as _evmod
            if text or files:
                # 本标签页的流式 token 已经把这段文字画进气泡了，带 origin 让它跳过这条广播，
                # 只让别的标签页/端补上；分段发送同理靠 origin 抑制。
                await _evmod.publish(req.user_id, "sessions", session_id=session_id,
                                     origin=getattr(req, "origin", None),
                                     appended=[{"role": "assistant", "text": text, "files": files or None}])
            else:
                await _evmod.publish(req.user_id, "sessions", session_id=session_id,
                                     origin=getattr(req, "origin", None))
        except Exception:
            pass

    outcome = RunOutcome()
    gen = exec_.runner.run(
        req.user_id,
        # Responses 不把 system 消息放进 input；稳定 system prompt 必须进入
        # instructions，否则人格、规则和工具行为约束都会丢失。
        exec_.system_prompt,
        exec_.prepared.anthr_messages if exec_.use_anthropic else exec_.prepared.oa_messages,
        use_anthropic=exec_.use_anthropic,
        model_cfg=exec_.model_cfg,
        session_id=session_id,
        session=exec_.session,
        on_interaction=on_interaction,
        reasoning_policy=exec_.run_config.reasoning_persistence,
        state_session_factory=exec_.session_factory,
    )
    try:
        async for item in consume_agent_events(
            gen, model_cfg=exec_.model_cfg, outcome=outcome,
            sink=WebStreamSink(on_tool_event=on_tool_event),
        ):
            yield item
    finally:
        from agent.llm.llm_select import release as _release_model
        _release_model(exec_.model_cfg)

    if outcome.cancelled:
        yield ("final", cancelled_response(outcome, session_id))
        return

    # 生成失败：错误文案不入历史/不反思，直接以 errored 终态返回
    if outcome.errored:
        yield ("final", AgentResponse(text=outcome.text, round_texts=list(outcome.round_texts),
                                      session_id=session_id, tokens_in=outcome.tokens_in,
                                      tokens_out=outcome.tokens_out, files=outcome.files,
                                      cancelled=False, errored=True, error_info=outcome.error_info,
                                      used_tools=False, interactions=outcome.interactions,
                                      tool_events=outcome.tool_events,
                                      compaction_applied=outcome.compaction_applied))
        return

    im_used_tools = await finalize_agent_run(
        req, exec_, outcome, publish_assistant=_publish_assistant,
    )

    yield ("final", AgentResponse(text=outcome.text, round_texts=list(outcome.round_texts),
                                  session_id=session_id, tokens_in=outcome.tokens_in,
                                  tokens_out=outcome.tokens_out, files=outcome.files,
                                  cancelled=False, errored=outcome.errored, error_info=outcome.error_info,
                                  used_tools=im_used_tools, interactions=outcome.interactions,
                                  tool_events=outcome.tool_events,
                                  compaction_applied=outcome.compaction_applied))


async def run_stream(
    req: AgentRequest,
    *,
    on_interaction=None,
    on_tool_event=None,
) -> AsyncIterator[tuple[str, object]]:
    """流式生成也复用同一 session gate，避免和普通生成并行。"""
    async with compress_conv.session_run_gate(req):
        async for item in _run_stream_unlocked(
            req, on_interaction=on_interaction, on_tool_event=on_tool_event,
        ):
            yield item


async def _collect(
    gen, include_meta: bool = False,
    model_cfg=None, on_tool_event=None, on_round=None,
) -> Tuple:
    """``_collect`` 兼容包装（LLM18 Phase 2）：scheduled_execution 与旧测试消费的
    tuple 契约，内部已改为统一事件消费器 ``consume_agent_events``。

    返回 (文本, in, out, cache_read, cache_write, errored, files, cancelled[, meta])；
    errored=True 时文本是错误文案（不入历史/不反思）。
    """
    outcome = RunOutcome()
    async for _ in consume_agent_events(
        gen, model_cfg=model_cfg, outcome=outcome,
        sink=CollectSink(on_tool_event=on_tool_event, on_round=on_round),
    ):
        pass
    result = (outcome.text, outcome.tokens_in, outcome.tokens_out,
              outcome.cache_read, outcome.cache_write, outcome.errored,
              outcome.files, outcome.cancelled)
    meta = {"tool_names": outcome.tool_names, "mutated": outcome.mutated,
            "interactions": outcome.interactions, "tool_events": outcome.tool_events,
            "compaction_applied": outcome.compaction_applied,
            "context_input": outcome.context_input, "round_texts": outcome.round_texts}
    return result + (meta,) if include_meta else result


async def run_scheduled_execution(*args, **kwargs):
    """兼容旧入口；定时任务执行适配器已归属 agent.scheduled_execution。"""
    from agent.scheduled_execution import run_scheduled_execution as execute_scheduled

    return await execute_scheduled(*args, **kwargs)
