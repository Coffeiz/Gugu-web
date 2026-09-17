"""Agent run 入口：collect（攒整段）与 stream（逐字流）两个 Sink 适配层。

PRD-LLM-18 起，两条入口共享同一套第一段准备（`agent/run/preparation.py` 的
`prepare_agent_run`），本文件只保留：

- `run_collect()` / `run_stream()` 公共入口：session 串行门 + EarlyExit 到各自
  形态的转换（collect 直接 return，stream 转 ("final", AgentResponse)）+ LLM
  事件流消费 + 统一收尾；
- 能力装配 helper 的兼容再导出（web.py / scheduled_execution / 测试按旧路径
  `from agent.runner import ...` 导入）；
- `_collect()` 事件消费器（scheduled_execution 仍在用；LLM18 Phase 2 与 stream
  内联消费合并后收敛为 `agent/run/execution.py`）。

会话历史/持久化/反思与 web 同口径：按 session_id 找/建会话、读历史窗口、存
用户+回复消息、对话后反思。session_id 由 worker 按平台用户从 Redis 取（续聊
不断），见 worker._im_session_*。
"""
from __future__ import annotations
from typing import AsyncIterator, Tuple

import json

from agent.security import sanitize
from agent.context import compress_conv
from agent.context.canonical_tool_history import persistable_canonical_batch_records
from agent.memory.reflection_input import build_reflection_input
from agent.capabilities.defaults import SYSTEM_MEMORY_ENABLED
from agent.conversation.session_metadata import schedule_summary, schedule_title
from agent.llm.llm_select import release as _release_model
from agent.models import AgentRequest, AgentResponse
from agent.run.contract import EarlyExit
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
    user_id = req.user_id
    session_id = exec_.session_id
    prepared = exec_.prepared
    anthr_messages = prepared.anthr_messages
    anthr_initial_len = prepared.anthr_initial_len
    oa_messages = prepared.oa_messages
    oa_initial_len = prepared.oa_initial_len
    rag_context = prepared.rag_context

    gen = exec_.runner.run(
        user_id,
        # Responses 不把 system 消息放进 input；稳定 system prompt 必须进入
        # instructions，否则人格、规则和工具行为约束都会丢失。
        exec_.system_prompt,
        anthr_messages if exec_.use_anthropic else oa_messages,
        use_anthropic=exec_.use_anthropic,
        model_cfg=exec_.model_cfg,
        session_id=session_id,
        session=exec_.session,
        on_interaction=on_interaction,
        reasoning_policy=exec_.run_config.reasoning_persistence,
        state_session_factory=exec_.session_factory,
    )
    settings = exec_.settings

    try:
        text, tin, tout, cache_read, cache_write, errored, sent_files, cancelled, meta = await _collect(
            gen, model_cfg=exec_.model_cfg, include_meta=True, on_tool_event=on_tool_event,
            on_round=on_round)
    finally:
        _release_model(exec_.model_cfg)   # least_loaded：请求结束减在途计数（其他方式 no-op）

    # 用户中途「算了」：网关已回「先不继续啦」，这里不再补发/不入历史/不反思（已执行的工具效果保留）
    if cancelled:
        return AgentResponse(text="", session_id=session_id, tokens_in=tin, tokens_out=tout, cancelled=True)

    im_used_tools = False
    # IM 出口兜底：发给用户/持久化之前确定性清洗（抹 tool_id 噪声、拦系统提示词泄露）
    if not errored:
        from agent.outbound import sanitize_outbound
        text = sanitize_outbound(text)
        text = sanitize.strip_disallowed_emoji(text)   # 出口兜底删白名单外 emoji（prompt 压不住）
        round_texts = []
        for round_text in meta.get("round_texts") or []:
            cleaned = sanitize_outbound(round_text)
            cleaned = sanitize.strip_disallowed_emoji(cleaned)
            if cleaned.strip():
                round_texts.append(cleaned)
        meta["round_texts"] = round_texts

    # IM/非流式生成也要保存逐轮展示时间线。canonical assistant.content 兼容旧历史，
    # 但刷新回放必须依赖 display_timeline，否则多轮输出只剩最后一轮。
    display_timeline = [
        {"kind": "assistant", "text": round_text}
        for round_text in (meta.get("round_texts") or [])
        if str(round_text or "").strip()
    ]

    # ── 持久化：工具调用轮次（anthropic）+ 回复 + 用量（报错不入历史）──
    if not errored:
        from agent.context.run_finalize import finalize_run
        await finalize_run(
            session_factory=exec_.session_factory,
            session_id=session_id,
            user_id=user_id,
            settings=settings,
            model_cfg=exec_.model_cfg,
            rag_context=rag_context,
            messages=anthr_messages if exec_.use_anthropic else oa_messages,
            initial_len=anthr_initial_len if exec_.use_anthropic else oa_initial_len,
            stance_text=prepared.stance_to_persist,
            user_message_id=getattr(exec_.user_message, "id", None),
            canonical_batches=persistable_canonical_batch_records(anthr_messages if exec_.use_anthropic else oa_messages),
            text=text,
            display_timeline=display_timeline or None,
            files=sent_files,
            tokens_in=tin,
            tokens_out=tout,
            cache_read=cache_read,
            cache_write=cache_write,
            compaction_applied=bool(meta.get("compaction_applied", False)),
        )

        # 新会话标题：移出关键路径，后台生成（会话已有首句截断做临时标题，好了再异步升级+推事件）。
        # 闲置后「重新聊天」=新会话，原来要在回复后再串行等一次 LLM 起标题才返回 → 慢一倍，这里去掉。
        if exec_.is_new_session and text:
            schedule_title(
                user_id, session_id, req.message, text, settings, exec_.use_anthropic,
                locale=req.locale or (exec_.snapshot or {}).get("locale"),
            )
        # 会话「一句话总结」：新会话先出一版，之后每 ~6 条刷新（跟着话题走）；供 search_conversations + 续接桥
        if text:
            schedule_summary(user_id, session_id, exec_.is_new_session, settings, exec_.use_anthropic)

        # 推第二次：咕咕的回复（用户消息已在生成前先推过，这里只补助手消息，
        # 网页就「先看到我发的、再看到回答」，而不是一轮结束一次性蹦出来）
        try:
            from app.core import events as _evmod
            assistant_rounds = [
                {"role": "assistant", "text": round_text}
                for round_text in (meta.get("round_texts") or [])
                if str(round_text or "").strip()
            ]
            if not assistant_rounds and text:
                assistant_rounds = [{"role": "assistant", "text": text}]
            if assistant_rounds or sent_files:
                appended = [
                    {**item, "files": sent_files or None}
                    if index == len(assistant_rounds) - 1 else item
                    for index, item in enumerate(assistant_rounds)
                ]
                if not appended:
                    appended = [{"role": "assistant", "text": "", "files": sent_files or None}]
                await _evmod.publish(user_id, "sessions", session_id=session_id,
                                     appended=appended)
            else:
                await _evmod.publish(user_id, "sessions", session_id=session_id)  # 至少 bump 列表
        except Exception:
            pass

        # 对话后反思（fire-and-forget）。IM 用「工具轮次让 anthr_messages 变长」当「咕咕动作了」代理，
        # 这样「嗯」确认后真建改东西的轮也会反思（openai 路径无此代理、回落到 user_msg 判，可接受）。
        if SYSTEM_MEMORY_ENABLED and text and exec_.context_policy.allow_memory_reflection:
            from agent.memory import reflection
            im_used_tools = exec_.use_anthropic and len(anthr_messages) > anthr_initial_len
            reflect_message, reflect_reply = build_reflection_input(
                req, anthr_messages, anthr_initial_len, text
            )
            if reflect_reply:
                reflection.schedule(user_id, req.user_name, reflect_message, reflect_reply, settings,
                                    used_tools=im_used_tools, session_id=session_id,
                                    group_mode=bool(req.chat_id and req.source != "web"))

    return AgentResponse(text=text, round_texts=list(meta.get("round_texts") or []), session_id=session_id, tokens_in=tin, tokens_out=tout,
                         cache_read=cache_read, cache_write=cache_write,
                         files=sent_files, errored=errored, used_tools=im_used_tools,
                         interactions=meta.get("interactions", []),
                         tool_events=meta.get("tool_events", []),
                         compaction_applied=bool(meta.get("compaction_applied", False)))


async def run_collect(
    req: AgentRequest, *, on_interaction=None, on_tool_event=None, on_round=None
) -> AgentResponse:
    """同一 session 串行生成；不同 session 仍可并行。"""
    async with compress_conv.session_run_gate(req):
        return await _run_collect_unlocked(
            req, on_interaction=on_interaction, on_tool_event=on_tool_event,
            on_round=on_round,
        )


async def _notify_tool_event(callback, event: dict) -> None:
    """通知 IM 工具状态展示；展示失败只写受限诊断，不影响 Agent 执行。"""
    if callback is None:
        return
    try:
        await callback(event)
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("agent.im.tool_event_display", exc)


async def _notify_round(callback, text: str) -> bool:
    """通知 IM 展示已完成的正文 round；展示失败不影响 Agent 执行。"""
    if callback is None:
        return False
    try:
        result = await callback(text)
        return result is not False
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("agent.im.round_display", exc)
        return False


# ── 流式版本（飞书 send_text_stream 用，2026-07-09 接入）──────────────────────
# run_collect 的"流式"变体：与 collect 共享同一套准备（prepare_agent_run），
# 差别只在消费 LLMRunner 流时逐字 yield token，让飞书 IM 端能实时 patch 卡片
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
    user_id = req.user_id
    session_id = exec_.session_id
    prepared = exec_.prepared
    anthr_messages = prepared.anthr_messages
    anthr_initial_len = prepared.anthr_initial_len
    oa_messages = prepared.oa_messages
    oa_initial_len = prepared.oa_initial_len
    rag_context = prepared.rag_context

    gen = exec_.runner.run(
        user_id,
        # Responses 不把 system 消息放进 input；稳定 system prompt 必须进入
        # instructions，否则人格、规则和工具行为约束都会丢失。
        exec_.system_prompt,
        anthr_messages if exec_.use_anthropic else oa_messages,
        use_anthropic=exec_.use_anthropic,
        model_cfg=exec_.model_cfg,
        session_id=session_id,
        session=exec_.session,
        on_interaction=on_interaction,
        reasoning_policy=exec_.run_config.reasoning_persistence,
        state_session_factory=exec_.session_factory,
    )
    settings = exec_.settings

    # ── 流式消费 generator：逐字 yield + 末尾 yield final ──
    from agent import providers
    provider_adapter = providers.adapter_for(exec_.model_cfg)
    san = sanitize.StreamSanitizer(adapter=provider_adapter)
    rounds: list[str] = []
    cur = ""
    tin = tout = cache_read = cache_write = 0
    files: list = []
    interactions: list[dict] = []
    tool_events: list[dict] = []
    compaction_applied = False
    cancelled = False
    errored = False
    errored_text = ""
    continuation_pending = False
    im_used_tools = False   # 流式 IM 失败时也会产出统一的 AgentResponse，不能依赖成功分支初始化。
    try:
        async for evt_str in gen:
            try:
                evt = json.loads(evt_str[6:])  # strip "data: "
            except Exception:
                continue
            t = evt.get("type")
            if t == "_new_round":
                cur += san.flush()
                rounds.append(cur)
                if cur.strip():
                    from agent.interactions.events import ROUND_END
                    yield (ROUND_END, cur)
                cur = ""
                san = sanitize.StreamSanitizer(adapter=provider_adapter)
                # 这个事件由核心循环在工具结果写回后发出，表示下一轮 LLM
                # 请求已经被承诺。若生成器随后异常结束，不能把前面已流出的
                # 工具前置说明误当作最终回复。
                continuation_pending = True
            elif t == "round_start":
                continuation_pending = False
            elif t == "_usage":
                tin = evt.get("input", 0)
                tout = evt.get("output", 0)
                cache_read = evt.get("cache_read", 0) or 0
                cache_write = evt.get("cache_write", 0) or 0
            elif t == "_context_compaction":
                compaction_applied = bool(evt.get("applied")) or compaction_applied
            elif t == "token":
                # 走同一清洗器（跟 _collect 一致）保证输出文本跟 run_collect 完全等价
                token = san.feed(evt.get("content", ""))
                cur += token
                if token:
                    yield ("token", token)
            elif t == "file" and evt.get("file"):
                files.append(evt["file"])
            elif t in {"tool_call", "tool_done"}:
                tool_event = dict(evt)
                tool_events.append(tool_event)
                await _notify_tool_event(on_tool_event, tool_event)
            elif t == "interaction_required":
                interactions.append({
                    key: evt[key]
                    for key in ("prompt_id", "kind", "title", "body", "options", "allow_text_input", "custom_input_active", "expires_at", "round_id", "tool_call_id", "force_display")
                    if key in evt
                })
            elif t == "_cancelled":
                cancelled = True
                break
            elif t == "error":
                errored_text = evt.get("message") or evt.get("detail") or "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
                errored = True
                break
    finally:
        _release_model(exec_.model_cfg)

    if continuation_pending and not cancelled and not errored:
        # 工具轮之后没有收到下一次 round_start，说明续轮在核心循环之外
        # 被截断（例如生成器提前关闭）。不允许静默成功或发布半截回复。
        errored = True
        errored_text = "工具结果已返回，但后续回复没有完成，请重试。"

    if cancelled:
        yield ("final", AgentResponse(text="", session_id=session_id,
                                      tokens_in=tin, tokens_out=tout, cancelled=True,
                                      interactions=interactions, tool_events=tool_events))
        return

    if not errored:
        cur += san.flush()
        rounds.append(cur)
        text = ""
        for r in reversed(rounds):
            r = r.strip()
            if r:
                text = r
                break
    else:
        text = errored_text

    # 出口兜底清洗（跟 run_collect 一致）
    if not errored:
        from agent.outbound import sanitize_outbound
        text = sanitize_outbound(text)
        text = sanitize.strip_disallowed_emoji(text)

    # 持久化（跟 run_collect 一致）：写入 db + schedule_title/summary/reflection/compress
    if not errored:
        from agent.context.run_finalize import finalize_run
        await finalize_run(
            session_factory=exec_.session_factory,
            session_id=session_id,
            user_id=user_id,
            settings=settings,
            model_cfg=exec_.model_cfg,
            rag_context=rag_context,
            messages=anthr_messages if exec_.use_anthropic else oa_messages,
            initial_len=anthr_initial_len if exec_.use_anthropic else oa_initial_len,
            stance_text=prepared.stance_to_persist,
            user_message_id=getattr(exec_.user_message, "id", None),
            canonical_batches=persistable_canonical_batch_records(anthr_messages if exec_.use_anthropic else oa_messages),
            text=text,
            files=files,
            tokens_in=tin,
            tokens_out=tout,
            cache_read=cache_read,
            cache_write=cache_write,
            compaction_applied=compaction_applied,
        )

        if exec_.is_new_session and text:
            schedule_title(
                user_id, session_id, req.message, text, settings, exec_.use_anthropic,
                locale=req.locale or (exec_.snapshot or {}).get("locale"),
            )
        if text:
            schedule_summary(user_id, session_id, exec_.is_new_session, settings, exec_.use_anthropic)

        try:
            from app.core import events as _evmod
            if text or files:
                # 本标签页的流式 token 已经把这段文字画进气泡了，带 origin 让它跳过这条广播，
                # 只让别的标签页/端补上；分段发送（一轮里多条 assistant 消息）同理靠 origin 抑制。
                await _evmod.publish(user_id, "sessions", session_id=session_id, origin=getattr(req, "origin", None),
                                     appended=[{"role": "assistant", "text": text, "files": files or None}])
            else:
                await _evmod.publish(user_id, "sessions", session_id=session_id, origin=getattr(req, "origin", None))
        except Exception:
            pass

        if SYSTEM_MEMORY_ENABLED and text and exec_.context_policy.allow_memory_reflection:
            from agent.memory import reflection
            im_used_tools = exec_.use_anthropic and len(anthr_messages) > anthr_initial_len
            reflect_message, reflect_reply = build_reflection_input(
                req, anthr_messages, anthr_initial_len, text
            )
            if reflect_reply:
                reflection.schedule(user_id, req.user_name, reflect_message, reflect_reply, settings,
                                    used_tools=im_used_tools, session_id=session_id,
                                    group_mode=bool(req.chat_id and req.source != "web"))

    yield ("final", AgentResponse(text=text, round_texts=[r.strip() for r in rounds if r.strip()],
                                  session_id=session_id, tokens_in=tin,
                                  tokens_out=tout, files=files, cancelled=False, errored=errored,
                                  used_tools=im_used_tools, interactions=interactions,
                                  tool_events=tool_events))


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
    gen: AsyncIterator[str], include_meta: bool = False,
    model_cfg=None, on_tool_event=None, on_round=None,
) -> Tuple:
    """消费 LLMRunner 的 SSE 流：清洗后攒文本 + 取用量 + 收集咕咕要发的文件。
    返回 (文本, in, out, errored, files)；errored=True 时文本是错误文案（不入历史/不反思）。

    文本按轮分段收集。兼容字段 ``text`` 仍取最后一轮；IM 展示层通过
    meta.round_texts 逐条发送，避免把多个 round 合并成一条消息，空 round 不发送。
    """
    from agent import providers
    provider_adapter = providers.adapter_for(model_cfg) if model_cfg is not None else None
    san = sanitize.StreamSanitizer(adapter=provider_adapter)
    rounds: list[str] = []   # 每轮文本分开存
    cur = ""
    tin = tout = cache_read = cache_write = 0
    context_input = 0
    files: list = []
    tool_names: list[str] = []
    interactions: list[dict] = []
    tool_events: list[dict] = []
    mutated = False
    cancelled = False
    compaction_applied = False
    continuation_pending = False

    async def flush_current_round() -> None:
        """在轮次切换或交互暂停前先发送已生成的正文。"""
        nonlocal cur, san
        cur += san.flush()
        rounds.append(cur)
        if cur.strip():
            from agent.outbound import sanitize_outbound
            display_round = sanitize.strip_disallowed_emoji(sanitize_outbound(cur)).strip()
            await _notify_round(on_round, display_round)
        cur = ""
        san = sanitize.StreamSanitizer(adapter=provider_adapter)

    async for evt_str in gen:
        try:
            evt = json.loads(evt_str[6:])
        except Exception:
            continue
        t = evt.get("type")
        if t == "_new_round":
            await flush_current_round()
            continuation_pending = True
        elif t == "round_start":
            continuation_pending = False
        elif t == "_usage":
            tin = evt.get("input", 0)
            context_input = max(context_input, int(evt.get("context_input", tin) or 0))
            tout = evt.get("output", 0)
            cache_read = evt.get("cache_read", 0) or 0
            cache_write = evt.get("cache_write", 0) or 0
        elif t == "_context_compaction":
            compaction_applied = bool(evt.get("applied")) or compaction_applied
        elif t == "token":
            cur += san.feed(evt.get("content", ""))
        elif t == "file" and evt.get("file"):
            files.append(evt["file"])   # 咕咕用 send_file 工具要发的文件
        elif t == "tool_call":
            tool_event = dict(evt)
            tool_events.append(tool_event)
            await _notify_tool_event(on_tool_event, tool_event)
            name = str(evt.get("name") or "")
            if name and name not in tool_names:
                tool_names.append(name)
            # 按工具注册时显式声明的 mutates 判断，不再靠名字前缀猜——猜测式前缀匹配
            # 会漏掉 remember（写长期记忆）、note_undo（删笔记）这类不落在
            # create_/update_/delete_/... 词表里的写工具，导致失败后重跑整轮时
            # 重复执行已经生效的写操作。
            from agent.tools import registry as _tool_registry
            tool = _tool_registry.snapshot().get(name)
            if tool is not None and tool.mutates:
                mutated = True
        elif t == "interaction_required":
            # ask_user 的交互回调会在生成器产出此事件后展示选择卡，并等待用户输入。
            # 若不先冲刷当前轮，前置说明会一直留在 cur，直到用户选择后核心循环才发
            # `_new_round`，导致 QQ 先看到选择卡、选完后才看到这段说明。
            await flush_current_round()
            # token 只在当前事件中短暂存在，不能写入日志或历史；平台 adapter 负责决定是否展示。
            interactions.append({
                key: evt[key]
                for key in ("prompt_id", "kind", "title", "body", "options", "allow_text_input", "custom_input_active", "expires_at", "round_id", "tool_call_id", "force_display")
                if key in evt
            })
        elif t == "tool_done":
            tool_event = dict(evt)
            tool_events.append(tool_event)
            await _notify_tool_event(on_tool_event, tool_event)
        elif t == "_cancelled":
            cancelled = True   # 用户中途「算了」：停止收集，网关已回「先不继续」，worker 不再补发
            break
        elif t == "error":
            detail = evt.get("message") or evt.get("detail") or "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
            result = (detail, tin, tout, cache_read, cache_write, True, files, False)
            meta = {"tool_names": tool_names, "mutated": mutated, "interactions": interactions,
                    "tool_events": tool_events, "compaction_applied": compaction_applied,
                    "context_input": context_input,
                    "round_texts": [r.strip() for r in rounds if r.strip()]}
            return result + (meta,) if include_meta else result
    if continuation_pending and not cancelled:
        # 工具结果后的续轮没有真正开始时，禁止把上一轮的过程文字作为成功回复。
        # 这也覆盖 IM 的非流式消费路径。
        result = ("工具结果已返回，但后续回复没有完成，请重试。", tin, tout,
                  cache_read, cache_write, True, files, False)
        meta = {"tool_names": tool_names, "mutated": mutated, "interactions": interactions,
                "tool_events": tool_events, "compaction_applied": compaction_applied,
                "context_input": context_input,
                "round_texts": [r.strip() for r in rounds if r.strip()]}
        return result + (meta,) if include_meta else result
    cur += san.flush()
    rounds.append(cur)

    text = ""
    for r in reversed(rounds):
        r = r.strip()
        if r:
            text = r
            break
    result = (text, tin, tout, cache_read, cache_write, False, files, cancelled)
    round_texts = [r.strip() for r in rounds if r.strip()]
    meta = {"tool_names": tool_names, "mutated": mutated, "interactions": interactions,
            "tool_events": tool_events, "compaction_applied": compaction_applied,
            "context_input": context_input, "round_texts": round_texts}
    return result + (meta,) if include_meta else result


async def run_scheduled_execution(*args, **kwargs):
    """兼容旧入口；定时任务执行适配器已归属 agent.scheduled_execution。"""
    from agent.scheduled_execution import run_scheduled_execution as execute_scheduled

    return await execute_scheduled(*args, **kwargs)
