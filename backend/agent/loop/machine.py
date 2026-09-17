"""Agent Loop 主循环状态机（PRD-LLM-25 LLM25-013）。

`run_loop` 是 `core.LLMRunner._run_loop` 的实现体；core 保留同名方法做兼容
转发（LoopScope hooks 按类属性替换 `LLMRunner._run_loop`，签名不变）。循环体
经 `_core.` 前缀引用 core 命名空间里的常量与兼容别名——这保证旧测试
`monkeypatch.setattr(core, "_stream_round"/"MAX_TOOL_CALLS"/...)` 在迁移后
仍然生效；Phase 6 清理时按实际引用收窄。
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncGenerator, Awaitable, Callable
from uuid import uuid4

from agent import core as _core


def _allow_tool_images(model_cfg: Any) -> bool:
    """判断工具读回的图片能否继续交给本轮实际模型。"""
    from app.core import chat_attach
    # 与当前用户附件 resolve_for_message 使用同一套显式配置/能力判断，不能只看
    # provider capability snapshot：用户手动开启 vision 时 snapshot 可能仍未探测。
    return chat_attach.vision_ready(model_cfg)


async def run_loop(
    runner: Any,
    driver: Any,
    user_id: Any,
    messages: list,
    ai: Any,
    system_text: str | None,
    *,
    session_id: int | None = None,
    session: Any = None,
    on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    reasoning_state: Any = None,
) -> AsyncGenerator[str, None]:
        """工具调用/核实阶段状态机/三条防幻觉守卫/空回复兜底/轮次上限——Anthropic 和
        OpenAI 两条格式共用同一份控制流，只在"怎么跑一轮/怎么把这轮结果写回历史"这几处
        调用 `driver`（`agent/_core.loop_drivers.py` 的 `AnthropicDriver`/`OpenAIDriver`）。

        合并后有一处行为变化，如实记在这里、不是本次改动的目标而是自然结果：原来
        `_run_openai` 整段没有 try/except 包裹流式调用，一旦 SDK 抛异常会原样往外炸；
        `_run_anthropic` 一直有（靠 _core.RetryableError/通用 Exception 两层兜底）。合并成
        一条共享循环后两边自然共用同一层兜底——OpenAI 路因此从"异常直接炸穿"变成
        "跟 Anthropic 路一样优雅降级成'咕咕开小差了'"，是明确的行为改善，不是意外。
        """
        # 这轮真正要跑的模型配置透传给工具层（见 agent/modelctx.py 文档）——工具判断
        # "当前模型支持什么"必须看这个，不能重新读静态的 get_settings().ai。
        from agent.llm import modelctx
        modelctx.set_model_cfg(ai)
        # 入口统一提升为带固定前缀边界的消息容器。直接调用 runner 的测试和少量
        # 内部调用仍可能传入普通 list，但运行中的追加、压缩和审计必须走同一套批次语义。
        if not hasattr(messages, "append_batch"):
            from agent.context.assembly import PromptMessages
            messages = PromptMessages(messages)
        # 每轮对话只允许 inspect_images 对网络图片发起一次读取；历史附件不占用该额度。
        from agent.tools import search as search_tools
        search_tools.reset_image_inspection_budget()
        goal_mode = _core._goal_mode_enabled(session)
        unlimited_mode = _core._unlimited_mode_enabled(session) or await _core._user_unlimited_mode_enabled(user_id)
        if goal_mode:
            if system_text:
                system_text = f"{system_text}{_core._GOAL_POLICY}"
            else:
                messages.insert(0, {"role": "system", "content": _core._GOAL_POLICY.strip()})
        if getattr(driver, "api_format", "") == "anthropic":
            before_count, after_count, history_changed = _core._sanitize_anthropic_history(messages)
            if history_changed:
                _core._log.warning("[anthropic] 请求历史已归一化：消息数 %s -> %s",
                              before_count, after_count)
        from agent.tools import registry as tool_registry
        tool_snapshot = tool_registry.snapshot_with_extras(tuple(runner.dynamic_tools.values()))
        initial_tool_names = runner.tool_names
        if (
            runner.capability_context is not None
            and not getattr(runner.capability_context, "metadata_only", False)
        ):
            initial_tool_names = list(runner.capability_context.select_for_messages(messages).tool_names)
        initial_tool_names = runner._provider_tool_names(initial_tool_names)
        current_tool_names = list(initial_tool_names)
        client, ctx = driver.prepare(
            initial_tool_names, ai, messages, system_text, tool_snapshot=tool_snapshot,
        )
        if reasoning_state is not None:
            await reasoning_state.prepared(driver, ctx)
        # 只把能力上下文挂到 provider request context，供 LoopScope 记录脱敏指标；
        # 不把目录或用户消息复制进 driver。
        if runner.capability_context is not None:
            ctx.capability_context = runner.capability_context
        loaded_skill_slugs = _core._loaded_skill_slugs(messages)
        # 当前用户消息是本轮 run 的保护边界。压缩时只处理它之前的历史，
        # 工具调用/结果追加后仍通过对象身份找到同一个起点。
        _run_conversation = getattr(messages, "conversation", messages)
        _run_start_index = _core.last_user_index(_run_conversation)
        _run_start_message = (
            _run_conversation[_run_start_index]
            if _run_start_index is not None
            else (_run_conversation[-1] if _run_conversation else None)
        )

        _mutset = _core._mutating_tools([*runner.tool_names, *runner.dynamic_tools], tool_snapshot)
        did_mutate = False; verify_count = 0; task_rounds = 0; verify_rounds = 0; empty_retry = 0
        any_tool_called = False
        responses_fallback_used = False
        pending_responses_capability_failure = None
        narration_retry = decision_retry = intent_retry = colon_retry = 0
        tool_intent_retry = 0   # “只说正在查询”或显式 requires_tools 未执行的守卫
        budget_stop_rounds = 0  # 预算停止后模型仍坚持调工具的连续轮数（止损用）
        guard_retry_pending = False
        colon_retry_pending = False
        guard_retry_buf: list[str] = []
        tool_calls_used = 0
        # 连续相同调用熔断状态：signature = (工具名, 归一化参数 JSON)，跨任务轮与核实轮计数
        repeat_breaker = _core.RepeatCallBreaker(_core.MAX_IDENTICAL_CONSECUTIVE_TOOL_CALLS)
        _request_conversation = getattr(messages, "conversation", messages)
        _request_user_index = _core.last_user_index(_request_conversation)
        _user_req = (
            _core.user_text_from_message(_request_conversation[_request_user_index])
            if _request_user_index is not None else ""
        )
        # 初始用户图片只需要首轮完整发送；首轮结束后折叠成稳定文本，避免下一轮和下一次
        # run 在同一历史位置分别出现 base64 与占位文本，导致 provider 从图片处断缓存。
        initial_volatile_indices = _core.loop_drivers._volatile_message_indices(messages)
        # 自我核实阶段：一旦进入就持续到收尾（含其查证用的 get_* 轮）。期间模型文字先缓冲——
        # 干净通过则整段丢弃（不把"已核实…"那种重复确认刷给用户）；发现并补做了，才在补做那轮发一次说明。
        verify_mode = False; verify_fixed = False; verify_queried = False
        finalize_pending = False
        # 破坏性工具的用户确认授权存在服务端（Redis）：确认后运行侧按原参数重投，
        # 确认门自动命中放行；运行时不做任何凭证续接，也不让模型再调用一次。
        total_in = total_out = total_cache = total_cache_write = 0
        # 一个 run 内 provider 每次返回的是该次请求的 context input；压缩判定使用
        # 这个 run 观察到的最高值，不能把多次请求相加，否则工具轮数越多越会误触发。
        run_context_usage = 0
        hard_budget_retries = 0
        compaction_applied = False
        run_id = f"run-{_core.uuid4().hex[:16]}"
        round_number = 0
        event_seq = 0

        def stream_event(event_type: str, **payload) -> str:
            """统一给兼容 SSE 事件补上可追踪身份；不写入用户正文或工具参数日志。"""
            nonlocal event_seq
            event_seq += 1
            return _core.encode_event(
                event_type,
                run_id=run_id,
                seq=event_seq,
                **payload,
            )

        async def compact_context_now() -> bool:
            """压缩旧 history，并让当前 run 使用新的上下文边界。"""
            nonlocal messages, compaction_applied
            from agent.context import compaction

            async def keep_generation_alive() -> None:
                """压缩等待期间刷新 Web 活跃快照，避免长压缩被误判为中断。"""
                if not session_id:
                    return
                wakeup = _core.asyncio.Event()
                while True:
                    await _core.genstream.touch(session_id)
                    try:
                        await _core.asyncio.wait_for(wakeup.wait(), timeout=30)
                    except _core.asyncio.TimeoutError:
                        continue

            heartbeat = _core.asyncio.create_task(keep_generation_alive())

            conversation = getattr(messages, "conversation", messages)
            before_count = len(conversation)
            before_summary = [
                item for item in conversation
                if isinstance(item, dict) and "<compacted-summary>" in str(item.get("content") or "")
            ]
            protected_from = next(
                (index for index, item in enumerate(conversation)
                 if item is _run_start_message),
                max(0, len(conversation) - 1),
            )
            try:
                try:
                    result = await compaction.compact_context(
                        list(conversation), session_id=session_id,
                        fixed_prefix_size=getattr(messages, "fixed_prefix_size", 0),
                        protected_from=protected_from,
                        model_cfg=ai,
                        system_text=system_text,
                        # 分支要带上本 run 的工具声明，provider 才算得出同一份可缓存
                        # 前缀（详见 compaction._generate_append_summary）。
                        branch_tools=getattr(ctx, "tools", None),
                    )
                except Exception as exc:
                    # 压缩失败时由调用方继续走确定性截断；不能让原始 overflow 变成
                    # “开小差”并丢掉本轮已有输出。
                    _core.diag_log("agent.context.compaction.summary", exc)
                    _core._log.warning("上下文压缩失败，继续使用确定性截断：%s", type(exc).__name__)
                    return False
            finally:
                heartbeat.cancel()
                try:
                    await heartbeat
                except _core.asyncio.CancelledError:
                    pass
            if hasattr(result, "messages"):
                compacted_messages, changed = result.messages, result.changed
            else:
                # 兼容旧的压缩适配器和回归 mock，避免 provider overflow
                # 路径因结果形状差异丢失本轮回复。
                compacted_messages, changed = result
            after_summary = [
                item for item in compacted_messages
                if isinstance(item, dict) and "<compacted-summary>" in str(item.get("content") or "")
            ]
            try:
                from agent.runtime.loopscope_trace.state import record_context_compaction
                record_context_compaction(
                    phase="completed",
                    reason=str(getattr(result, "return_reason", "unknown") or "unknown"),
                    changed=bool(changed),
                    before_messages=before_count,
                    after_messages=len(compacted_messages),
                    before_summary_count=len(before_summary),
                    after_summary_count=len(after_summary),
                    before_summary_chars=sum(len(str(item.get("content") or "")) for item in before_summary),
                    after_summary_chars=sum(len(str(item.get("content") or "")) for item in after_summary),
                    protected_from=protected_from,
                )
            except Exception:
                pass
            if not changed:
                return False
            if hasattr(messages, "replace_conversation"):
                messages.replace_conversation(compacted_messages)
            else:
                messages = compacted_messages
            compaction_applied = True
            if reasoning_state is not None:
                await reasoning_state.boundary_changed("baseline_changed")
            yield_event = {"type": "_context_compaction", "phase": "completed", "applied": True,
                           "reason": getattr(result, "return_reason", "compacted")}
            # 事件由调用方发送，避免 helper 自己消费生成器控制流。
            _context_compaction_event[0] = yield_event
            return True

        async def apply_deterministic_compaction_fallback(reason: str) -> bool:
            """摘要压缩未生效时立即裁切，避免继续把超大上下文送入 provider。"""
            nonlocal messages, compaction_applied
            from agent.context.budget import enforce_provider_overflow_fallback

            conversation = getattr(messages, "conversation", messages)
            protected_from = next(
                (index for index, item in enumerate(conversation)
                 if item is _run_start_message),
                max(0, len(conversation) - 1),
            )
            result = enforce_provider_overflow_fallback(
                messages, system_text or "", getattr(ai, "context_tokens", 256000),
                protected_from=protected_from,
            )
            if not result.changed:
                return False
            compaction_applied = True
            if reasoning_state is not None:
                await reasoning_state.boundary_changed("baseline_changed")
            _context_compaction_event[0] = {
                "type": "_context_compaction", "phase": "completed", "applied": True,
                "reason": reason,
            }
            return True

        def usage_compaction_due() -> bool:
            # 90% 阈值判定归 loop/rounds（PRD-LLM-25 LLM25-006）；压缩执行仍归 context 模块。
            return _core.loop_rounds.usage_compaction_due(
                run_context_usage=run_context_usage,
                context_tokens=int(getattr(ai, "context_tokens", 0) or 0),
                compaction_applied=compaction_applied,
            )

        async def compact_after_usage_threshold() -> bool:
            """统一在 provider usage 达到 90% 后压缩旧 history。"""
            nonlocal messages, compaction_applied
            # 90% 观察线只在 provider usage 层维护一份，避免 core 再复制预算语义。
            if not usage_compaction_due():
                return False
            if await compact_context_now():
                return True
            if await apply_deterministic_compaction_fallback("usage_threshold_fallback"):
                _core._log.warning("[core] provider usage 达到 90% 但摘要压缩未生效，执行确定性裁切")
                return True
            _core._log.error("[core] provider usage 达到 90%，摘要和确定性裁切均未生效")
            return False

        _context_compaction_event = [None]

        async def notify_interaction(prompt, options, *, round_id_value=None) -> None:
            """在进入等待前通知 IM 展示层；Web 仍只消费下方的流事件。"""
            if on_interaction is None:
                return
            await on_interaction({
                "prompt_id": prompt.id,
                "kind": prompt.kind,
                "title": prompt.title,
                "body": prompt.body,
                "options": options,
                "expires_at": prompt.expires_at.isoformat(),
                "round_id": round_id_value,
                "force_display": True,
            })

        while True:
            _budget = _core.loop_rounds.round_budget_action(
                round_number=round_number, verify_mode=verify_mode,
                task_rounds=task_rounds, verify_rounds=verify_rounds,
                unlimited_mode=unlimited_mode,
                max_rounds=runner.max_rounds, max_verify_rounds=runner.max_verify_rounds,
                max_absolute_rounds=_core.MAX_ABSOLUTE_ROUNDS,
            )
            if _budget is _core.loop_rounds.RoundBudgetAction.ABSOLUTE_LIMIT:
                _core._log.error(
                    "[core] Agent 触发绝对轮次安全上限：rounds=%s limit=%s run=%s",
                    round_number, _core.MAX_ABSOLUTE_ROUNDS, run_id,
                )
                yield f"data: {_core.json.dumps({'type': 'error', 'detail': '本次任务执行轮次过多，已安全停止；请重新发起任务。'}, ensure_ascii=False)}\n\n"
                return
            # 普通模式下，核实轮拥有独立预算；无限模式跳过该业务封顶。
            # 最后一轮额外留给模型输出核实后的收束文本。
            if verify_mode:
                if _budget is _core.loop_rounds.RoundBudgetAction.VERIFY_LIMIT:
                    if runner.stop_on_budget:
                        break
                    # 与任务轮上限同款弹窗：询问是否解除本轮限制继续，
                    # 而不是直接用兜底文案硬停止。拿不到交互通道（无
                    # session/DB）时退回循环后的兜底文案。
                    from app.services.interactions import create_goal_mode_prompt, wait_for_resolution

                    interaction = await create_goal_mode_prompt(
                        user_id=user_id, session_id=session_id,
                    )
                    if interaction is None:
                        break
                    prompt, options = interaction
                    yield stream_event(
                        "interaction_required",
                        round_id=round_id if round_number else None,
                        prompt_id=prompt.id,
                        kind=prompt.kind,
                        title=prompt.title,
                        body=prompt.body,
                        options=options,
                        expires_at=prompt.expires_at.isoformat(),
                        force_display=True,
                    )
                    await notify_interaction(
                        prompt, options,
                        round_id_value=round_id if round_number else None,
                    )
                    answer = await wait_for_resolution(
                        user_id=user_id,
                        prompt_id=prompt.id,
                        heartbeat=lambda: _core.genstream.touch(session_id),
                        cancel_check=lambda: _core._im_cancelled(session_id),
                    )
                    _answer_kind = _core.classify_interaction_answer(answer)
                    if _answer_kind == "user_cancelled":
                        # 用户在弹窗上主动点取消＝正常收尾：补一段收尾正文走正常
                        # 持久化+done，不留 SSE 黑洞，也不把终止当异常。
                        for _frame in _core._closing_frames(
                            _core._PAUSE_CLOSE_TEXT, next_round=round_number + 1,
                        ):
                            yield _frame
                        return
                    if _answer_kind == "aborted":
                        yield f"data: {_core.json.dumps({'type': '_cancelled'}, ensure_ascii=False)}\n\n"
                        return
                    if _answer_kind == "expired":
                        # 弹窗过期不另造文案：落到循环后的兜底，把已完成
                        # 内容和"请重新发起"一并交代清楚。
                        break
                    if _answer_kind == "resume_unlimited":
                        # 该按钮的语义是解除本次 run 的轮次限制；核实与任务
                        # 轮次都清零后回到同一主循环继续执行。
                        unlimited_mode = True
                        verify_rounds = 0
                        task_rounds = 0
                        yield stream_event(
                            "_new_round",
                            round_id=round_id if round_number else "round-0",
                            next_round=round_number + 1,
                        )
                        continue
                    break
                verify_rounds += 1
            else:
                if _budget is _core.loop_rounds.RoundBudgetAction.TASK_LIMIT:
                    if runner.stop_on_budget:
                        _core._log.warning("[core] 自动任务 LLM 轮次达到上限：rounds=%s limit=%s", task_rounds, runner.max_rounds)
                        yield f"data: {_core.json.dumps({'type': 'error', 'detail': f'定时任务达到模型轮次上限（{runner.max_rounds} 轮）'}, ensure_ascii=False)}\n\n"
                        return
                    from app.services.interactions import create_goal_mode_prompt

                    interaction = await create_goal_mode_prompt(
                        user_id=user_id, session_id=session_id,
                    )
                    if interaction is None:
                        yield f"data: {_core.json.dumps({'type': 'token', 'content': f'本次已达到 {runner.max_rounds} 轮。想继续的话，请发送 /unlimited 开启无限工具调用模式，再发送“继续”。'}, ensure_ascii=False)}\n\n"
                        return
                    prompt, options = interaction
                    yield stream_event(
                        "interaction_required",
                        round_id=round_id if round_number else None,
                        prompt_id=prompt.id,
                        kind=prompt.kind,
                        title=prompt.title,
                        body=prompt.body,
                        options=options,
                        expires_at=prompt.expires_at.isoformat(),
                        force_display=True,
                    )
                    await notify_interaction(
                        prompt, options,
                        round_id_value=round_id if round_number else None,
                    )
                    from app.services.interactions import wait_for_resolution
                    answer = await wait_for_resolution(
                        user_id=user_id,
                        prompt_id=prompt.id,
                        heartbeat=lambda: _core.genstream.touch(session_id),
                        cancel_check=lambda: _core._im_cancelled(session_id),
                    )
                    _answer_kind = _core.classify_interaction_answer(answer)
                    if _answer_kind == "user_cancelled":
                        # 用户主动点取消＝正常收尾：补收尾正文走正常持久化+done。
                        for _frame in _core._closing_frames(
                            _core._PAUSE_CLOSE_TEXT, next_round=round_number + 1,
                        ):
                            yield _frame
                        return
                    if _answer_kind == "aborted":
                        yield f"data: {_core.json.dumps({'type': '_cancelled'}, ensure_ascii=False)}\n\n"
                        return
                    if _answer_kind == "expired":
                        yield f"data: {_core.json.dumps({'type': 'error', 'detail': '这次继续操作已过期，请重新发起任务。'}, ensure_ascii=False)}\n\n"
                        return
                    if _answer_kind == "resume_unlimited":
                        # 该按钮的语义是解除本次 run 的工具调用限制，不创建 goal
                        # 目标任务；清零轮次后回到同一主循环继续执行。
                        unlimited_mode = True
                        task_rounds = 0
                        yield stream_event(
                            "_new_round",
                            round_id=round_id if round_number else "round-0",
                            next_round=round_number + 1,
                        )
                        continue
                    return
                task_rounds += 1
            # 用户中途「算了」→ 轮间协作中断（单次 LLM 流式调用本身切不了，故粒度是轮与轮之间）
            if await _core._im_cancelled(session_id):
                yield f"data: {_core.json.dumps({'type': '_cancelled'})}\n\n"
                return

            _tok = 0
            result = None
            round_number += 1
            round_id = f"round-{round_number}"
            yield stream_event("round_start", round_id=round_id)
            _verify_buf = []   # 核实轮缓冲区：先攒着，回合结束按"有没有补做"决定 flush 还是丢弃
            try:
                # 每次 provider 请求前刷新 selected tools。工具调用/结果由驱动构造批次，
                # 再由核心循环一次性提交到 history；这里仅更新原生 tools 参数。
                if (
                    runner.capability_context is not None
                    and not getattr(runner.capability_context, "fixed_adapter", False)
                    and not getattr(runner.capability_context, "metadata_only", False)
                ):
                    selected = runner.capability_context.select_for_messages(messages)
                    current_tool_names = runner._provider_tool_names(list(selected.tool_names))
                    driver.update_tools(
                        ctx, current_tool_names,
                        tool_snapshot=tool_snapshot,
                    )
                # 注入 core 命名空间的 _core._stream_round：旧测试 monkeypatch 本模块属性仍生效。
                while True:
                    try:
                        _round_gen = driver.run_round(client, ctx, messages, stream_round=_core._stream_round)
                        async for _kind, _val in _round_gen:
                            if _kind == "done":
                                result = _val
                                break
                            if _kind == "retry":
                                # 重试状态行：任何模式都显示（它是状态不是正文，不进消息流）
                                yield stream_event("retry", attempt=_val.get("attempt"),
                                                   max_retries=_val.get("max_retries"),
                                                   next_retry_in=_val.get("next_retry_in"),
                                                   error_kind=_val.get("error_kind"))
                                continue
                            if verify_mode:
                                _verify_buf.append(_val)   # 核实阶段文字不实时发，先缓冲
                            elif goal_mode:
                                # 等待完成标记判定，避免把内部标记流给用户。
                                pass
                            elif guard_retry_pending:
                                # 守卫追问后的正文先不展示；只有该轮真的发起工具调用时，
                                # 才说明守卫生效并丢弃这段自我辩解。
                                guard_retry_buf.append(_val)
                            else:
                                # 普通 draft 是用户可见的 round 正文，随 provider 流实时发送。
                                # thinking/reasoning 不会从各 provider driver 作为 token 进入这里；
                                # 核实和守卫文字仍由上面的专用分支隐藏。
                                yield stream_event("token", content=_val, round_id=round_id)
                            # 流式途中也协作检查取消：单轮长回答没有「下一轮」，只能在这里掐断；
                            # 退出生成器会关闭 stream、断开上游请求，真正停掉生成（不是只丢弃后续 token）
                            _tok += 1
                            if _tok % _core._CANCEL_CHECK_EVERY == 0 and await _core._im_cancelled(session_id):
                                yield f"data: {_core.json.dumps({'type': '_cancelled'})}\n\n"
                                # 显式关掉 run_round 生成器：Python 3.14 下 async for 提前退出时
                                # close 会被推迟到 GC，LoopScope 的 span 会一直挂着 running。
                                # aclose() 立即注入 GeneratorExit，hooks.traced_round 同步把
                                # span 标成 cancelled，不用等 GC 才收尾。
                                await _round_gen.aclose()
                                return
                        break
                    except Exception as exc:
                        from agent.providers.openai_responses import ResponsesCompatibilityError
                        if not (
                            isinstance(exc, ResponsesCompatibilityError)
                            and driver.api_format == "responses"
                            and _tok == 0
                            and result is None
                            and not responses_fallback_used
                        ):
                            raise
                        responses_fallback_used = True
                        # 先保留失败信息；只有 fallback 的 Chat Completions 请求成功，
                        # 才能确认这是 Responses 兼容性问题并污染能力缓存。
                        pending_responses_capability_failure = exc
                        if reasoning_state is not None:
                            await reasoning_state.failed("responses_incompatible")
                        from agent.loop_drivers import OpenAIDriver
                        driver = OpenAIDriver()
                        client, ctx = driver.prepare(
                            current_tool_names, ai, messages, system_text,
                            tool_snapshot=tool_snapshot,
                        )
                        if runner.capability_context is not None:
                            ctx.capability_context = runner.capability_context
                        _core._log.warning(
                            "Responses 完整请求不兼容，当前 run 回退 Chat Completions：status=%s",
                            exc.status_code,
                        )
                if pending_responses_capability_failure is not None and result is not None:
                    # 兼容性回退只在本次 run 内生效；不再写回任何能力探测缓存
                    # （Chat API 下的自动协议切换已随推理接续策略一并移除）。
                    pending_responses_capability_failure = None
            except _core.RetryableError as e:
                if reasoning_state is not None:
                    await reasoning_state.failed("provider_rejected")
                from agent.context.budget import is_context_overflow_error
                overflow = is_context_overflow_error(e) or is_context_overflow_error(e.cause) if e.cause else is_context_overflow_error(e)
                if overflow and hard_budget_retries < 1:
                    yield stream_event("_context_compaction", phase="started", reason="provider_overflow")
                    if await compact_context_now():
                        hard_budget_retries += 1
                        _event = _context_compaction_event[0]
                        _context_compaction_event[0] = None
                        if _event:
                            yield f"data: {_core.json.dumps(_event, ensure_ascii=False)}\n\n"
                        if verify_mode:
                            verify_rounds -= 1
                        else:
                            task_rounds -= 1
                        _core._log.warning("[core] provider overflow 后完成历史压缩，重试当前 round")
                        continue
                    if await apply_deterministic_compaction_fallback("provider_overflow_fallback"):
                        _event = _context_compaction_event[0]
                        _context_compaction_event[0] = None
                        if _event:
                            yield f"data: {_core.json.dumps(_event, ensure_ascii=False)}\n\n"
                        hard_budget_retries += 1
                        if verify_mode:
                            verify_rounds -= 1
                        else:
                            task_rounds -= 1
                        _core._log.warning("[core] provider 返回上下文超量，执行一次确定性截断重试")
                        continue
                    yield stream_event("_context_compaction", phase="completed", applied=False,
                                       reason="not_applied")
                # _core._stream_round 已经把原始异常记进受限诊断出口、也记过 WARNING 了，这里不重复记；
                # 只根据 cause 类型挑一句降级文案给用户。文案带「上游 状态码 错误类型」的
                # 脱敏技术标签（不含上游正文/provider 名，正文在 diag_log）——用户能一眼
                # 看出是上游过载还是故障，而不是只收到一句 ack（2026-09-18 529 排查后定稿）。
                # 429 限流与 529 过载同属「上游忙」，按状态码判定、与具体 SDK 解耦
                # （anthropic/openai 两条链路的重试用尽都落到这里）
                from agent.providers.errors import (is_provider_http_error, upstream_status_tag,
                                                    upstream_busy_status)
                busy = upstream_busy_status(e)
                provider_error = is_provider_http_error(e)
                attempts_done = int(getattr(e, "attempt", 0) or 0)
                tag = upstream_status_tag(e)
                retried = f"已自动重试 {attempts_done} 次" if attempts_done > 0 else None
                if busy:
                    detail = f"模型服务过载（上游 {tag}）" + (f"，{retried}仍未恢复" if retried else "") + "，请稍后再试 🙏"
                    message_key = "chatUi.providerBusyExhausted"
                elif provider_error:
                    detail = f"模型服务暂时不可用（上游 {tag}）" + (f"，{retried}" if retried else "") + "，请稍后重试。"
                    message_key = "chatUi.providerUnavailable"
                else:
                    detail = "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
                    message_key = "chatUi.genericError"
                yield f"data: {_core.json.dumps({'type': 'error', 'detail': detail, 'message_key': message_key, 'message_params': {'tag': tag, 'attempts': attempts_done}}, ensure_ascii=False)}\n\n"
                return
            except Exception as e:
                if reasoning_state is not None:
                    await reasoning_state.failed("provider_rejected")
                from agent.context.budget import is_context_overflow_error
                if is_context_overflow_error(e) and hard_budget_retries < 1:
                    yield stream_event("_context_compaction", phase="started", reason="provider_overflow")
                    if await compact_context_now():
                        hard_budget_retries += 1
                        _event = _context_compaction_event[0]
                        _context_compaction_event[0] = None
                        if _event:
                            yield f"data: {_core.json.dumps(_event, ensure_ascii=False)}\n\n"
                        if verify_mode:
                            verify_rounds -= 1
                        else:
                            task_rounds -= 1
                        _core._log.warning("[core] provider overflow 后完成历史压缩，重试当前 round")
                        continue
                    if await apply_deterministic_compaction_fallback("provider_overflow_fallback"):
                        _event = _context_compaction_event[0]
                        _context_compaction_event[0] = None
                        if _event:
                            yield f"data: {_core.json.dumps(_event, ensure_ascii=False)}\n\n"
                        hard_budget_retries += 1
                        if verify_mode:
                            verify_rounds -= 1
                        else:
                            task_rounds -= 1
                        _core._log.warning("[core] provider 返回上下文超量，执行一次确定性截断重试")
                        continue
                    yield stream_event("_context_compaction", phase="completed", applied=False,
                                       reason="not_applied")
                # 已吐过 token 中途出错（emitted 就原样抛的路径）或其他未预期异常——按未知处理：
                # 原始进受限诊断出口，可见日志只留类型名，不带原始 str(e)。
                # where 里带上 provider + api_format——2026-07-14 那次 MiniMax AttributeError
                # 故障排查时，_core.diag_log 没记 provider，只能靠静态代码分析猜是哪家（PRD-LLM-1
                # 「待确认问题」），这次直接把它写进日志，下次同类问题一眼就能看出是哪个 provider。
                _core.diag_log(f"agent.core.main_loop provider={getattr(ai, 'provider', '') or 'unknown'} "
                         f"format={driver.api_format}", e)
                _core._log.error("LLM 调用中途出错：%s", type(e).__name__)
                from agent.providers.errors import is_provider_http_error, upstream_status_tag
                provider_error = is_provider_http_error(e)
                if provider_error:
                    tag = upstream_status_tag(e)
                    detail = f"模型服务暂时不可用（上游 {tag}），请稍后重试。"
                    message_key = "chatUi.providerUnavailable"
                else:
                    tag = ""
                    detail = "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
                    message_key = "chatUi.genericError"
                yield f"data: {_core.json.dumps({'type': 'error', 'detail': detail, 'message_key': message_key, 'message_params': {'tag': tag}}, ensure_ascii=False)}\n\n"
                return

            total_in  += result.usage_in
            total_out += result.usage_out
            total_cache += result.cache_tokens
            total_cache_write += result.cache_write_tokens
            run_context_usage = max(run_context_usage, _core._provider_context_usage(driver, result))
            if reasoning_state is not None:
                await reasoning_state.round_finished(driver, ctx, result, round_id)
            # 发送单个 provider 请求的脱敏 usage；run 结束时的 _usage 仍保留为
            # 本次 run 累计值，诊断和观测层可据此区分“当前上下文”与“累计消耗”。
            yield stream_event(
                "_provider_usage",
                round_id=round_id,
                input=int(result.usage_in or 0),
                context_input=int(_core._provider_context_usage(driver, result) or 0),
                output=int(result.usage_out or 0),
                cache_read=int(result.cache_tokens or 0),
                cache_write=int(result.cache_write_tokens or 0),
            )

            _requires_tools = result.requires_tools
            if _requires_tools is None:
                _requires_tools = bool(result.tool_calls)
            # 行动意图守卫判断的是当前模型轮次，而不是整个 run 是否曾经调用过工具。
            # 前面轮次可能已经查过数据，但本轮仍可能只输出“我继续处理：”而没有实际调用；
            # 这种情况下仍必须触发守卫，不能被 any_tool_called 这个历史状态挡住。
            round_tool_called = bool(result.tool_calls)

            if initial_volatile_indices:
                _core.loop_drivers._collapse_volatile_messages(messages, initial_volatile_indices)
                initial_volatile_indices = set()

            # 统一策略：每个 provider round 返回后都检查实际上下文用量，
            # 最终回复轮也必须经过同一条 90% 压缩路径。
            if usage_compaction_due():
                yield stream_event("_context_compaction", phase="started", reason="usage_threshold")
                if await compact_after_usage_threshold():
                    _event = _context_compaction_event[0]
                    _context_compaction_event[0] = None
                    if _event:
                        yield f"data: {_core.json.dumps(_event, ensure_ascii=False)}\n\n"
                else:
                    yield stream_event("_context_compaction", phase="completed", applied=False,
                                       reason="not_applied")

            if result.tool_calls:
                if guard_retry_pending:
                    guard_retry_pending = False
                    colon_retry_pending = False
                    guard_retry_buf.clear()
                any_tool_called = True   # 本轮真调了工具 → narration 兜底不触发
                # 核实阶段首次补做（本轮调了增删改）→ 把"发现漏了X，补一下"说明发一次；之后的核对文字仍静默
                if verify_mode and not verify_fixed and _verify_buf and any(
                    _core._resolve_tool_call(tc.name, tc.input)[0] in _mutset
                    for tc in result.tool_calls
                ):
                    async for _line in _core.genstream.typed_stream(''.join(_verify_buf)):   # 逐字流式，与正常回复一致
                        yield _line
                dispatched = []
                pending_interaction = None
                repeat_breaker.begin_round()   # 熔断按轮计数：同轮多相同调用合法，跨轮重复才累积
                remaining_tool_calls = (
                    None if (goal_mode or unlimited_mode) else max(0, runner.max_tool_calls - tool_calls_used)
                )
                round_limit_exceeded = (
                    not (goal_mode or unlimited_mode)
                    and runner.max_rounds is not None
                    and task_rounds >= runner.max_rounds
                )
                tool_budget_exceeded = (
                    remaining_tool_calls is not None
                    and len(result.tool_calls) > remaining_tool_calls
                )
                tool_budget_stop_requested = False
                if round_limit_exceeded or tool_budget_exceeded:
                    if runner.stop_on_budget:
                        reason = (
                            f"定时任务达到模型轮次上限（{runner.max_rounds} 轮）"
                            if round_limit_exceeded
                            else f"定时任务达到工具调用上限（{runner.max_tool_calls} 次）"
                        )
                        _core._log.warning("[core] 自动任务预算达到上限：%s", reason)
                        yield f"data: {_core.json.dumps({'type': 'error', 'detail': reason}, ensure_ascii=False)}\n\n"
                        return
                    # 两种限制都必须在 dispatch 前暂停整批待执行请求。用户点击继续后，
                    # 先放行这批请求，再解除对应的后续上限，避免模型看到“工具结果已失败”
                    # 后直接总结，或把同一批工具重新规划一遍。
                    if round_limit_exceeded:
                        _core._log.warning("[core] LLM 轮次达到上限：rounds=%s limit=%s", task_rounds, runner.max_rounds)
                        from app.services.interactions import create_goal_mode_prompt
                        interaction = await create_goal_mode_prompt(
                            user_id=user_id, session_id=session_id,
                        )
                    else:
                        _core._log.warning("[core] 工具调用达到 run 上限：used=%s limit=%s", tool_calls_used, runner.max_tool_calls)
                        from app.services.interactions import create_tool_budget_prompt
                        interaction = await create_tool_budget_prompt(
                            user_id=user_id, session_id=session_id,
                        )
                    if interaction is None:
                        detail = (
                            "本次已达到 30 轮。想继续的话，请发送 /unlimited 开启无限工具调用模式，再发送“继续”。"
                            if round_limit_exceeded
                            else "这次查询步骤有点多，咕咕先停在这里了；前面已经获得的结果仍然有效。"
                        )
                        event_type = "token" if round_limit_exceeded else "error"
                        yield f"data: {_core.json.dumps({'type': event_type, 'content' if event_type == 'token' else 'detail': detail}, ensure_ascii=False)}\n\n"
                        return
                    prompt, options = interaction
                    yield stream_event(
                        "interaction_required",
                        round_id=round_id,
                        prompt_id=prompt.id,
                        kind=prompt.kind,
                        title=prompt.title,
                        body=prompt.body,
                        options=options,
                        expires_at=prompt.expires_at.isoformat(),
                        force_display=True,
                    )
                    await notify_interaction(prompt, options, round_id_value=round_id)
                    from app.services.interactions import wait_for_resolution
                    answer = await wait_for_resolution(
                        user_id=user_id,
                        prompt_id=prompt.id,
                        heartbeat=lambda: _core.genstream.touch(session_id),
                        cancel_check=lambda: _core._im_cancelled(session_id),
                    )
                    if (
                        isinstance(answer, dict)
                        and answer.get("status") == "cancelled"
                        and not _core._user_cancel(answer)
                    ):
                        yield f"data: {_core.json.dumps({'type': '_cancelled'}, ensure_ascii=False)}\n\n"
                        return
                    if answer is None:
                        yield f"data: {_core.json.dumps({'type': 'error', 'detail': '这次继续操作已过期，请重新发起任务。'}, ensure_ascii=False)}\n\n"
                        return
                    if answer.get("option_id") == "continue":
                        # 继续执行同一批原始 tool call，不重新交给模型判断是否总结；
                        # 同时解除轮次和工具调用上限，保持“继续”语义一致。
                        unlimited_mode = True
                        task_rounds = 0
                        remaining_tool_calls = None
                        round_limit_exceeded = False
                        tool_budget_exceeded = False
                    elif round_limit_exceeded:
                        # 轮次限制下用户选择停止时，当前工具批次尚未写入历史，直接收尾；
                        # 不再额外请求模型，避免把“停止”变成一次新的空续轮。
                        yield f"data: {_core.json.dumps({'type': 'token', 'content': '已先停在这里，前面成功执行的调整仍然有效。'}, ensure_ascii=False)}\n\n"
                        return
                    else:
                        # 拒绝时阻止这整批尚未执行的请求，并让模型在无工具模式下
                        # 基于已取得的结果生成说明，而不是静默结束。
                        tool_budget_stop_requested = True
                        task_rounds = 0
                        remaining_tool_calls = 0
                        tool_budget_exceeded = False
                        driver.update_tools(ctx, [], tool_snapshot=tool_snapshot)
                for call_index, tc in enumerate(result.tool_calls):
                    raw_call_name = getattr(tc, "name", None)
                    dispatch_target, dispatch_input, protocol_error = _core._resolve_tool_call(
                        raw_call_name, getattr(tc, "input", None)
                    )
                    effective_tool_name = dispatch_target
                    # 工具名污染全局兜底：模型偶发把 JSON 参数写成 XML 片段拼进工具名
                    # （如 create_file"><target>…）。在名字定稿处统一抢救一次；适配器
                    # 保留 provider 原始调用用于历史配对，UI、熔断与 dispatch 使用干净名；
                    # dispatch 层另有同款兜底，覆盖
                    # use_skill 委托等不经本循环的入口。
                    if (
                        effective_tool_name != "invalid_tool_call"
                        and tool_snapshot.get(effective_tool_name) is None
                    ):
                        from agent.tools.base import salvage_tool_name
                        salvaged = salvage_tool_name(effective_tool_name)
                        if salvaged is not None and tool_snapshot.get(salvaged) is not None:
                            _core._log.info("[core] 工具名污染兜底：%r → %r", effective_tool_name, salvaged)
                            if raw_call_name == "call_tool":
                                dispatch_target = salvaged
                            else:
                                tc.name = salvaged
                                dispatch_target = salvaged
                            effective_tool_name = salvaged
                    label = runner._label(effective_tool_name)
                    if verify_mode:   # 复查前缀后端拼接（可在「状态命名」面板改 _verify_prefix；支持多候选随机）
                        label = runner._label("_verify_prefix", "复查 · ") + label
                    if tool_budget_stop_requested or (
                        remaining_tool_calls is not None and call_index >= remaining_tool_calls
                    ):
                        # 仍然为 provider 的每个 tool call 补一个结果，避免留下孤儿 tool_call；
                        # 但不再执行真实工具，随后直接结束本轮，防止模型继续扩张搜索。
                        tool_call_id = getattr(tc, "id", None) or f"{round_id}-tool-{call_index + 1}"
                        yield stream_event("tool_call", round_id=round_id, tool_call_id=tool_call_id,
                                           name=effective_tool_name, label=label, input=dispatch_input, verify=verify_mode,
                                           status="skipped")
                        yield stream_event("tool_done", round_id=round_id, tool_call_id=tool_call_id,
                                           name=effective_tool_name, label=label, verify=verify_mode,
                                           status="skipped", result=_core._TOOL_BUDGET_EXHAUSTED)
                        dispatched.append((tc, _core._TOOL_BUDGET_EXHAUSTED))
                        continue
                    # 连续相同调用熔断：只对显式声明 repeat_safe 的观察类工具生效
                    # （写工具每次调用都有真实副作用、联网读取结果可能变化，都不能拦）。
                    # 任何非 repeat_safe 的调用（含 ask_user）都会打断「连续」语义，
                    # 重置计数——中间穿插过一次别的调用就不算连续了。
                    if protocol_error is None and not tc.parse_error:
                        # 连续相同调用熔断判定归 loop/tools（PRD-LLM-25 LLM25-008）。
                        if repeat_breaker.register(tool_snapshot, effective_tool_name, dispatch_input):
                                tool_call_id = getattr(tc, "id", None) or f"{round_id}-tool-{call_index + 1}"
                                _core._log.warning(
                                    "[core] 连续相同工具调用熔断：%s x%d（run=%s）",
                                    effective_tool_name, repeat_breaker.count, run_id,
                                )
                                yield stream_event("tool_call", round_id=round_id, tool_call_id=tool_call_id,
                                                   name=effective_tool_name, label=label, input=dispatch_input, verify=verify_mode,
                                                   status="skipped")
                                yield stream_event("tool_done", round_id=round_id, tool_call_id=tool_call_id,
                                                   name=effective_tool_name, label=label, verify=verify_mode,
                                                   status="skipped", result=_core._REPEAT_CALL_STOP_RESULT)
                                dispatched.append((tc, _core._REPEAT_CALL_STOP_RESULT))
                                continue
                    tool_calls_used += 1
                    if protocol_error is not None:
                        tool_call_id = getattr(tc, "id", None) or f"{round_id}-tool-{call_index + 1}"
                        yield stream_event(
                            "tool_call", round_id=round_id, tool_call_id=tool_call_id,
                            name=effective_tool_name, label=label, input={}, verify=verify_mode,
                            status="invalid",
                        )
                        protocol_result = _core.json.dumps(protocol_error, ensure_ascii=False)
                        yield stream_event(
                            "tool_done", round_id=round_id, tool_call_id=tool_call_id,
                            name=effective_tool_name, label=label, verify=verify_mode,
                            status="error", result=protocol_result,
                        )
                        dispatched.append((tc, protocol_result))
                        continue
                    if tc.parse_error:
                        # OpenAI 路专属：工具参数 JSON 被截断解析失败——别拿空参跑，改回一条错误
                        # tool_result 让模型精简参数后重发；不真 dispatch、不置 did_mutate。
                        tool_call_id = getattr(tc, "id", None) or f"{round_id}-tool-{call_index + 1}"
                        yield stream_event("tool_call", round_id=round_id, tool_call_id=tool_call_id,
                                           name=effective_tool_name, label=label, input={}, verify=verify_mode,
                                           status="invalid")
                        yield stream_event("tool_done", round_id=round_id, tool_call_id=tool_call_id,
                                           name=effective_tool_name, label=label, verify=verify_mode,
                                           status="error", result=_core.loop_drivers.TOOL_ARGS_TRUNCATED_ERROR)
                        dispatched.append((tc, _core.loop_drivers.TOOL_ARGS_TRUNCATED_ERROR))
                        continue
                    await _core._im_set_tool_state(effective_tool_name)
                    # 自检轮工具照常显示，但打 verify 标记：前端凭 verify 收尾不冒「生成中」点点（否则回复完还在转、像卡住）
                    tool_call_id = getattr(tc, "id", None) or f"{round_id}-tool-{call_index + 1}"
                    yield stream_event("tool_call", round_id=round_id, tool_call_id=tool_call_id,
                                       name=effective_tool_name, label=label, input=dispatch_input, verify=verify_mode,
                                       status="running")
                    # Skill 正文第一次通过 use_skill 进入 history 后，正文指纹一致时复用；
                    # 文件更新或 history 中仍是旧版标记时，重新加载正文。
                    skill_slug = None
                    if effective_tool_name == "use_skill":
                        from agent.skills import resolve_skill_slug
                        requested_skill = str((dispatch_input or {}).get("name") or "")
                        skill_slug = resolve_skill_slug(requested_skill) or requested_skill.strip().lower()
                    current_skill_digest = None
                    if skill_slug:
                        capability_context = runner.capability_context
                        if capability_context is not None:
                            current_skill_digest = capability_context.skill_digest(skill_slug)
                        if not current_skill_digest:
                            from agent.skills import skill_content_digest
                            current_skill_digest = skill_content_digest(skill_slug)
                    skill_meta = None
                    if skill_slug and runner.capability_context is not None:
                        skill_meta = runner.capability_context.skill_meta(skill_slug)
                    is_user_skill = bool(skill_meta and skill_meta.source == "user")
                    if (
                        skill_slug
                        and current_skill_digest
                        and loaded_skill_slugs.get(skill_slug) == current_skill_digest
                        and not is_user_skill
                    ):
                        res = _core.json.dumps({
                            "skill": skill_slug,
                            "already_loaded": True,
                            "message": "该技能正文已在当前上下文中，无需重复加载。",
                        }, ensure_ascii=False)
                        artifact = None
                    else:
                        res, artifact = await _core._dispatch_in_session(
                            user_id, dispatch_target, dispatch_input,
                            session_id=session_id, session=session, run_id=run_id,
                            tool_snapshot=tool_snapshot, skill_state=loaded_skill_slugs,
                        )
                        if skill_slug and _core._is_successful_tool_result(res):
                            try:
                                payload = _core.json.loads(res) if isinstance(res, str) else res
                            except (TypeError, ValueError):
                                payload = None
                            marker = payload.get("_capability_usage") if isinstance(payload, dict) else None
                            digest = marker.get("content_digest") if isinstance(marker, dict) else None
                            if isinstance(digest, str) and digest:
                                loaded_skill_slugs[skill_slug] = digest
                            elif current_skill_digest:
                                loaded_skill_slugs[skill_slug] = current_skill_digest
                    # 固定 Adapter 已在进入 dispatch 前归一到业务工具名，因此 ask_user
                    # 与直调走同一条交互卡创建流程。
                    if effective_tool_name in {"ask_user", "manage_mcp_servers"}:
                        # ask_user 与 MCP 凭据表单都会把当前 Run 挂起：先把工具往返写进
                        # provider history，等待回答后由 interaction service 替换 pending
                        # result，再从同一 session 继续，而不是把按钮文案伪装成新用户消息。
                        import json as _json
                        try:
                            ask_payload = _json.loads(res) if isinstance(res, str) else res
                        except (TypeError, ValueError):
                            ask_payload = None
                        from app.services.interactions import create_agent_prompt
                        interaction = None
                        if isinstance(ask_payload, dict) and ask_payload.get("_interaction") == "ask_user":
                            interaction = await create_agent_prompt(
                                user_id=user_id,
                                session_id=session_id,
                                tool_call_id=tool_call_id,
                                tool_name=effective_tool_name,
                                payload=ask_payload,
                            )
                        if interaction is not None:
                            prompt, actions = interaction
                            secret_fields = list((prompt.schema_json or {}).get("secret_fields") or [])
                            pending_result = _json.dumps({
                                "status": "waiting_input",
                                "prompt_id": prompt.id,
                            }, ensure_ascii=False)
                            dispatched.append((tc, pending_result))
                            pending_interaction = _core._PendingInteraction(
                                prompt.id, tool_call_id, effective_tool_name,
                            )
                            yield stream_event("tool_done", round_id=round_id,
                                               tool_call_id=tool_call_id, name=effective_tool_name, label=label,
                                               verify=verify_mode, status="waiting", result=pending_result)
                            yield stream_event(
                                "interaction_required", round_id=round_id,
                                tool_call_id=tool_call_id, prompt_id=prompt.id,
                                kind=prompt.kind, title=prompt.title, body=prompt.body,
                                options=actions, allow_text_input=bool(
                                    (prompt.schema_json or {}).get("allow_text_input", False)
                                ), secret_fields=secret_fields,
                                expires_at=prompt.expires_at.isoformat(),
                            )
                            if on_interaction is not None:
                                await on_interaction({
                                    "prompt_id": prompt.id,
                                    "kind": prompt.kind,
                                    "title": prompt.title,
                                    "body": prompt.body,
                                    "options": actions,
                                    "allow_text_input": bool(
                                        (prompt.schema_json or {}).get("allow_text_input", False)
                                    ),
                                    "secret_fields": secret_fields,
                                    "expires_at": prompt.expires_at.isoformat(),
                                    "round_id": round_id,
                                    "tool_call_id": tool_call_id,
                                })
                            break
                    # 统一交互桥：保留工具原有确认门，同时向 Guguchat/Web 发出按钮事件。
                    # 桥接失败不能影响工具结果写回模型，因此只在成功创建时发送事件。
                    from app.services.interactions import create_tool_confirmation
                    interaction = await create_tool_confirmation(
                        user_id=user_id, session_id=session_id, tool_name=effective_tool_name,
                        tool_call_id=tool_call_id, result=res,
                    )
                    if interaction:
                        pending_interaction = _core._PendingInteraction(
                            interaction["prompt_id"], tool_call_id, effective_tool_name,
                            {
                                "name": effective_tool_name,
                                "label": label,
                                "target": dispatch_target,
                                "input": dispatch_input,
                            },
                        )
                        dispatched.append((tc, res))
                        yield stream_event("interaction_required", round_id=round_id,
                                           tool_call_id=tool_call_id, **interaction)
                        if on_interaction is not None:
                            await on_interaction({
                                **interaction,
                                "round_id": round_id,
                                "tool_call_id": tool_call_id,
                            })
                        yield stream_event("tool_done", round_id=round_id,
                                           tool_call_id=tool_call_id, name=effective_tool_name, label=label,
                                           verify=verify_mode, status="waiting", result=res)
                        break
                    if _core._call_requires_verification(effective_tool_name, dispatch_input, tool_snapshot, _mutset) and _core._is_successful_tool_result(res):
                        did_mutate = True   # 本次成功做过增删改 → 立刻强制自我核实
                        if verify_mode:
                            verify_fixed = True   # 核实阶段里补了东西 → 确有遗漏
                    elif verify_mode and _core._call_observes(effective_tool_name, dispatch_input, tool_snapshot):
                        verify_queried = True   # 核实阶段真的用查询工具查证了（不是嘴上确认）
                    yield stream_event("tool_done", round_id=round_id, tool_call_id=tool_call_id,
                                       name=effective_tool_name, label=label, verify=verify_mode,
                                       status="success" if _core._is_successful_tool_result(res) else "error",
                                       result=res)
                    if artifact:
                        yield _core._artifact_sse(artifact)
                    dispatched.append((tc, res))
                from agent.context.assembly import NewMessageBatch
                from agent.context.canonical_tool_history import canonical_tool_round

                # 工具结果里的图片块只能发给明确支持视觉输入的本轮模型。不能只看
                # 工具本身是否成功，否则 GLM 等文本模型会收到 image_url 并被 provider
                # 以 400 拒绝，导致工具结果已经返回却无法继续对话。
                allow_tool_images = _allow_tool_images(ai)
                provider_round = driver.build_tool_round(
                    result, dispatched, allow_images=allow_tool_images,
                )
                if getattr(driver, "api_format", "") == "anthropic":
                    try:
                        from agent.runtime.loopscope_trace.state import record_anthropic_structure_probe
                        record_anthropic_structure_probe(
                            provider=getattr(getattr(ctx, "adapter", None), "name", ""),
                            model=getattr(ctx, "model", ""),
                            response_blocks=getattr(result, "raw", []),
                            provider_messages=provider_round,
                        )
                    except Exception:
                        pass
                batch = NewMessageBatch.from_canonical_messages(
                    canonical_tool_round(result, dispatched),
                    provider_messages=provider_round,
                    metadata={"round_id": round_id},
                )
                try:
                    from agent.runtime.loopscope_trace.state import record_canonical_batch
                    record_canonical_batch(
                        digest=batch.batch_digest,
                        round_id=round_id,
                        message_count=len(batch.canonical_messages),
                    )
                except Exception:
                    pass
                if getattr(runner.capability_context, "fixed_adapter", False):
                    from agent.context.canonical_tool_history import (
                        SkillSchemaEvent, ToolDiscoveryEvent, append_event, tool_schema_event,
                    )
                    # canonical event 也先进入同一批次，不能在工具 round 提交后再单独
                    # 修改 history；否则下一次重建时消息粒度和顺序可能发生变化。
                    batch_history = list(getattr(messages, "conversation", messages)) + batch.messages

                    def add_event(event) -> None:
                        before = len(batch_history)
                        append_event(batch_history, event)
                        if len(batch_history) > before:
                            event_message = batch_history[-1]
                            # Schema/discovery 是 capability context，不是工具回执。
                            # 必须保持独立的 canonical user message，禁止并入
                            # tool_result，否则 sanitize/reload 后消息边界会漂移。
                            batch.append(event_message)

                    for tc, _res in dispatched:
                        resolved_name, resolved_input, resolve_error = _core._resolve_tool_call(
                            tc.name, tc.input
                        )
                        if resolve_error is None and resolved_name == "get_tool_schema":
                            try:
                                declaration = _core.json.loads(_res) if isinstance(_res, str) else _res
                            except (TypeError, ValueError):
                                declaration = None
                            declared = (
                                declaration.get("tool_schemas", ())
                                if isinstance(declaration, dict) else ()
                            )
                            valid_names = tuple(
                                name for name in declared
                                if isinstance(name, str)
                                and name in getattr(runner.capability_context.snapshot, "tools", {})
                            )
                            if valid_names:
                                add_event(ToolDiscoveryEvent(valid_names))
                                for name in valid_names:
                                    tool = tool_snapshot.get(name)
                                    if tool is not None:
                                        add_event(tool_schema_event(tool))
                            continue
                        if resolve_error is None and resolved_name == "use_skill":
                            skill_name = str((resolved_input or {}).get("name") or "").strip()
                            resolved_skill = None
                            from agent.skills import resolve_skill_slug
                            resolved_skill = resolve_skill_slug(skill_name) or skill_name
                            skill_meta = getattr(runner.capability_context, "snapshot", None)
                            skill_meta = getattr(skill_meta, "skills", {}).get(resolved_skill)
                            if getattr(skill_meta, "kind", None) != "skill":
                                skill_meta = None
                            related = tuple(getattr(skill_meta, "related_tools", ()) or ())
                            if related:
                                add_event(SkillSchemaEvent(skill_name, related))
                                for name in related:
                                    tool = tool_snapshot.get(name)
                                    if tool is not None:
                                        add_event(tool_schema_event(tool))
                            continue
                        target_name = None
                        if resolve_error is None and resolved_name != "call_tool":
                            try:
                                error_payload = _core.json.loads(_res) if isinstance(_res, str) else _res
                            except (TypeError, ValueError):
                                error_payload = None
                            recovery = (
                                error_payload.get("_schema_recovery")
                                if isinstance(error_payload, dict) else None
                            )
                            if isinstance(recovery, dict) and recovery.get("needed") is True:
                                # 直接调用或经固定 Adapter 调用业务工具且参数校验失败时，
                                # 都把最终工具 Schema 写入 canonical history；下一轮不再猜。
                                target_name = resolved_name
                        if target_name:
                            tool = tool_snapshot.get(target_name)
                            if tool is not None:
                                add_event(tool_schema_event(tool))
                messages.append_batch(batch)
                if pending_interaction is not None:
                    from app.services.interactions import wait_for_resolution
                    pending_tool_call_id = pending_interaction.tool_call_id
                    answer = await wait_for_resolution(
                        user_id=user_id, prompt_id=pending_interaction.prompt_id,
                        heartbeat=lambda: _core.genstream.touch(session_id),
                        cancel_check=lambda: _core._im_cancelled(session_id),
                    )
                    if _core._user_cancel(answer):
                        # 用户在交互卡上主动点「取消」＝正常收尾，不是异常终止。先把取消
                        # 结果落进本轮工具往返（否则下一次 run 回放会把已取消的操作读成
                        # 还在等），再补终态事件与收尾正文走正常持久化+done。
                        _core._replace_tool_result(
                            messages,
                            tool_call_id=pending_tool_call_id,
                            result=answer,
                        )
                        yield stream_event("tool_done", **_core._pending_tool_signal(
                            "cancelled", answer, pending_interaction, verify=verify_mode,
                        ))
                        for _frame in _core._closing_frames(
                            _core._CANCEL_CLOSE_TEXT, next_round=round_number + 1,
                        ):
                            yield _frame
                        return
                    if isinstance(answer, dict) and answer.get("status") == "cancelled":
                        yield stream_event("tool_done", **_core._pending_tool_signal(
                            "cancelled", None, pending_interaction, verify=verify_mode,
                        ))
                        yield f"data: {_core.json.dumps({'type': '_cancelled'}, ensure_ascii=False)}\n\n"
                        return
                    if answer is None:
                        yield stream_event("tool_done", **_core._pending_tool_signal(
                            "error", None, pending_interaction, verify=verify_mode,
                        ))
                        yield f"data: {_core.json.dumps({'type': 'error', 'detail': '这次交互已过期，请重新告诉我你的选择。'}, ensure_ascii=False)}\n\n"
                        return
                    replay_ctx = pending_interaction.replay
                    if (
                        isinstance(answer, dict)
                        and answer.get("status") == "confirmed"
                        and isinstance(replay_ctx, dict)
                    ):
                        # 用户确认破坏性操作：服务端按原参数直接执行这一次工具调用
                        # （授权已在消费确认动作时兑换到 Redis，覆盖同一操作摘要与
                        # 身份范围），把真实执行结果写回本轮工具往返后进入下一轮。
                        # 模型因此只需要「汇报执行结果」，不必也不应再次调用该工具。
                        from agent.interactions.confirmations import is_block
                        try:
                            executed, artifact = await _core._dispatch_in_session(
                                user_id, replay_ctx["target"], replay_ctx["input"],
                                session_id=session_id, session=session, run_id=run_id,
                                tool_snapshot=tool_snapshot, skill_state=loaded_skill_slugs,
                            )
                        except Exception as exc:
                            _core.diag_log("agent.core.confirm_replay", exc)
                            executed, artifact = {"status": "error", "text": "确认后执行失败，请重新发起操作。"}, None
                        if is_block(executed):
                            # 授权没兑换成功（Redis 异常等）。占位确认结果不能当工具
                            # 结果发出去，否则模型会以为操作已执行。
                            executed, artifact = {"status": "error", "text": "确认未生效，请重新发起操作。"}, None
                        replay_payload = _core._tool_result_payload(executed)

                        # 某些确认型工具是两阶段交互：确认后先完成写入，再返回
                        # ``_interaction: ask_user`` 让用户补充安全信息（例如 MCP
                        # server 凭据）。重放结果不能直接交给模型，否则模型会把
                        # waiting_input 当成普通工具结果，重新规划同一个调用；在
                        # unlimited 模式下这会演变成无界的 provider 请求循环。
                        if (
                            isinstance(replay_payload, dict)
                            and replay_payload.get("_interaction") == "ask_user"
                        ):
                            from app.services.interactions import create_agent_prompt

                            followup = await create_agent_prompt(
                                user_id=user_id,
                                session_id=session_id,
                                tool_call_id=pending_tool_call_id,
                                tool_name=replay_ctx["name"],
                                payload=replay_payload,
                            )
                            if followup is None:
                                _core.diag_log(
                                    "agent.core.confirm_replay_interaction",
                                    RuntimeError("confirmed replay returned an invalid interaction"),
                                )
                                replay_payload = {
                                    "status": "error",
                                    "text": "确认后需要补充的信息无法建立，请重新发起操作。",
                                }
                            else:
                                prompt, actions = followup
                                secret_fields = list((prompt.schema_json or {}).get("secret_fields") or [])
                                waiting_payload = _json.dumps({
                                    "status": "waiting_input",
                                    "prompt_id": prompt.id,
                                }, ensure_ascii=False)
                                _core._replace_tool_result(
                                    messages,
                                    tool_call_id=pending_tool_call_id,
                                    result=waiting_payload,
                                )
                                yield stream_event(
                                    "tool_done",
                                    round_id=round_id,
                                    tool_call_id=pending_tool_call_id,
                                    name=replay_ctx["name"],
                                    label=replay_ctx["label"],
                                    verify=verify_mode,
                                    status="waiting",
                                    result=waiting_payload,
                                )
                                interaction_payload = {
                                    "round_id": round_id,
                                    "tool_call_id": pending_tool_call_id,
                                    "prompt_id": prompt.id,
                                    "kind": prompt.kind,
                                    "title": prompt.title,
                                    "body": prompt.body,
                                    "options": actions,
                                    "allow_text_input": bool(
                                        (prompt.schema_json or {}).get("allow_text_input", False)
                                    ),
                                    "secret_fields": secret_fields,
                                    "expires_at": prompt.expires_at.isoformat(),
                                }
                                yield stream_event("interaction_required", **interaction_payload)
                                if on_interaction is not None:
                                    await on_interaction(interaction_payload)
                                answer = await wait_for_resolution(
                                    user_id=user_id,
                                    prompt_id=prompt.id,
                                    heartbeat=lambda: _core.genstream.touch(session_id),
                                    cancel_check=lambda: _core._im_cancelled(session_id),
                                )
                                if _core._user_cancel(answer) or (
                                    isinstance(answer, dict) and answer.get("status") == "cancelled"
                                ):
                                    yield stream_event(
                                        "tool_done",
                                        round_id=round_id,
                                        tool_call_id=pending_tool_call_id,
                                        name=replay_ctx["name"],
                                        label=replay_ctx["label"],
                                        verify=verify_mode,
                                        status="cancelled",
                                    )
                                    yield f"data: {_core.json.dumps({'type': '_cancelled'}, ensure_ascii=False)}\n\n"
                                    return
                                if answer is None:
                                    yield f"data: {_core.json.dumps({'type': 'error', 'detail': '凭据输入已过期，请重新发起操作。'}, ensure_ascii=False)}\n\n"
                                    return
                                _core._replace_tool_result(
                                    messages,
                                    tool_call_id=pending_tool_call_id,
                                    result=answer,
                                )
                                yield stream_event(
                                    "tool_done",
                                    round_id=round_id,
                                    tool_call_id=pending_tool_call_id,
                                    name=replay_ctx["name"],
                                    label=replay_ctx["label"],
                                    verify=verify_mode,
                                    status="success" if _core._is_successful_tool_result(answer) else "error",
                                    result=answer,
                                )
                                yield stream_event(
                                    "_new_round",
                                    round_id=round_id,
                                    next_round=round_number + 1,
                                )
                                continue
                        _core._replace_tool_result(
                            messages,
                            tool_call_id=pending_tool_call_id,
                            result=replay_payload,
                        )
                        replay_ok = _core._is_successful_tool_result(replay_payload)
                        if _core._call_requires_verification(replay_ctx["name"], replay_ctx["input"], tool_snapshot, _mutset) and replay_ok:
                            did_mutate = True   # 确认后真的改了数据 → 照常进入自我核实
                            if verify_mode:
                                verify_fixed = True
                        elif verify_mode and _core._call_observes(replay_ctx["name"], replay_ctx["input"], tool_snapshot):
                            verify_queried = True
                        yield stream_event(
                            "tool_done", round_id=round_id, tool_call_id=pending_tool_call_id,
                            name=replay_ctx["name"], label=replay_ctx["label"],
                            verify=verify_mode,
                            status="success" if replay_ok else "error", result=replay_payload,
                        )
                        if artifact:
                            yield _core._artifact_sse(artifact)
                        yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                        continue
                    replaced = _core._replace_tool_result(
                        messages,
                        tool_call_id=pending_tool_call_id,
                        result=answer,
                    )
                    if not replaced:
                        # 继续发送未更新的 waiting_input 结果会让 Anthropic 兼容端点把
                        # 当前工具回合判为非法；立即停止并留下脱敏诊断，避免把竞态伪装成
                        # 普通模型故障。
                        error = RuntimeError("pending tool result missing during interaction resume")
                        _core.diag_log("agent.core.interaction_resume", error)
                        yield f"data: {_core.json.dumps({'type': 'error', 'detail': '这次确认状态已失效，请重新发起操作。'}, ensure_ascii=False)}\n\n"
                        return
                    yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                    continue
                if tool_budget_stop_requested:
                    # 预算停止后模型仍反复输出工具调用：给一次 followup 让它收束；
                    # 若继续坚持（工具已被摘除，任何调用都是空转），强制终结而不是
                    # 空转到绝对轮次上限——2026-09-18 实测 MiniMax 连转 75 轮烧到
                    # 100 轮保险丝，期间每轮 ~3s 全是占位结果。
                    budget_stop_rounds += 1
                    if budget_stop_rounds >= 2:
                        _core._log.warning(
                            "[core] 工具预算停止后模型连续 %d 轮仍尝试调用工具，强制收束 run=%s",
                            budget_stop_rounds, run_id,
                        )
                        stop_text = "工具调用额度已用完，我先停在这里；已完成的操作都保留。想继续的话，发「继续」让我接着做。"
                        async for _line in _core.genstream.typed_stream(stop_text):
                            yield _line
                        if reasoning_state is not None:
                            await reasoning_state.completed()
                        yield f"data: {_core.json.dumps({'type': '_usage', 'input': total_in, 'context_input': run_context_usage, 'output': total_out, 'cache_read': total_cache, 'cache_write': total_cache_write})}\n\n"
                        return
                    messages.append_batch(driver.build_followup(
                        result, _core._TOOL_BUDGET_STOP_PROMPT,
                    ))
                    yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                    continue
                # 工具结果已经入历史，直接接复查 prompt。旧流程会先多请求一次模型来生成
                # "已完成"，随后才开始复查；这轮没有新信息，只会徒增一次等待。
                verify_cycle_allowed = (
                    unlimited_mode
                    or runner.max_verify_cycles is None
                    or verify_count < runner.max_verify_cycles
                )
                if did_mutate and verify_cycle_allowed:
                    verify_count += 1
                    did_mutate = False
                    verify_mode = True
                    verify_queried = False
                    messages.append_batch([{"role": "user", "content": _core._VERIFY_PROMPT}])
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue

            # 自我核实：① 理论上工具结果后会立即注入核实 prompt；这里保留为轮次封顶等
            # 边界状态的兜底；② 已进核实阶段却只嘴上确认、没真调过查询工具（verify_queried=False）→ 强制再追一轮真查。
            # 普通模式受 _core.MAX_VERIFY 封顶防死循环；无限模式仍保留服务级停止保护。
            # 补做会再置 did_mutate → 触发下一轮核实。
            verify_cycle_allowed = (
                unlimited_mode
                or runner.max_verify_cycles is None
                or verify_count < runner.max_verify_cycles
            )
            _need_verify = did_mutate and verify_cycle_allowed
            _need_force  = verify_mode and not verify_queried and not did_mutate and verify_cycle_allowed
            if _need_verify or _need_force:
                verify_count += 1
                did_mutate = False
                verify_mode = True   # 进入/保持核实阶段 → 之后文字先缓冲
                messages.append_batch(driver.build_followup(
                    result, _core._VERIFY_FORCE_PROMPT if _need_force else _core._VERIFY_PROMPT,
                ))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue

            # 核验提示已经要求模型在查询后直接总结；如果当前轮已经给出可交付的结果，
            # 不再重复发一轮最终收束请求。只有“我确认一下/已核实”这类过程播报才需要
            # 追加收束轮，避免它被直接展示给用户。
            if (verify_mode and verify_queried and not finalize_pending
                    and _core._is_verify_placeholder("".join(_verify_buf))):
                finalize_pending = True
                messages.append_batch(driver.build_followup(result, _core._FINALIZE_PROMPT))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue

            # 核实阶段结束：不再需要补做/强查 → 把缓冲的核实文字发给用户，退出核实模式。
            if verify_mode and _verify_buf:
                async for _line in _core.genstream.typed_stream(''.join(_verify_buf)):
                    yield _line
            verify_mode = False
            _verify_buf = []

            _final_text = result.text
            if goal_mode:
                completed = _core._goal_completed(_final_text)
                _final_text = _core._strip_goal_marker(_final_text)
                if _final_text.strip():
                    async for _line in _core.genstream.typed_stream(_final_text):
                        yield _line
                if not completed:
                    messages.append_batch(driver.build_guard_followup(
                        result,
                        "目标尚未完成。继续执行剩余步骤；只有完整目标全部完成后，才输出内部完成标记。",
                    ))
                    yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                    continue
            if guard_retry_pending:
                # 冒号续写守卫允许模型补完不需要工具的回复；其余守卫后的纯文字
                # 仍视为尚未执行的操作承诺，不把“我刚才只是……”显示成第二条回复。
                if (
                    colon_retry_pending
                    and _final_text.strip()
                    and not _core._ends_with_colon(_final_text)
                    and not _core._looks_like_narration(_final_text, runner.locale)
                    and not _core._announces_intent(_final_text, runner.locale)
                    and not _core._is_tool_progress_only(_final_text, runner.locale)
                    and _requires_tools is not True
                ):
                    async for _line in _core.genstream.typed_stream(_final_text):
                        yield _line
                guard_retry_pending = False
                colon_retry_pending = False
                guard_retry_buf.clear()
                if reasoning_state is not None:
                    await reasoning_state.completed()
                yield f"data: {_core.json.dumps({'type': '_usage', 'input': total_in, 'context_input': run_context_usage, 'output': total_out, 'cache_read': total_cache, 'cache_write': total_cache_write})}\n\n"
                return
            # 空回复兜底：整轮无正文、没动工具、不在核实阶段 → 先追一轮要正文，仍空给句得体兜底。
            if not _final_text.strip() and not did_mutate and not verify_mode:
                if empty_retry < 1:
                    empty_retry += 1
                    messages.append_batch(driver.build_empty_retry(result))
                    yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                    continue
                fb = "嗯…我这下没太接住，你再说一遍、或者换个说法，我马上跟上～"
                async for _line in _core.genstream.typed_stream(fb):   # 空回复兜底也走逐字流式
                    yield _line
                _final_text = fb
            # narration 兜底：整段生成一个工具都没真调，但文字在"假装"读/改文件 → 追一轮逼它真调。
            # 只追一次；核实阶段不算（那是另一套）。
            if (not any_tool_called and not verify_mode and narration_retry < 1
                    and _core._looks_like_narration(_final_text, runner.locale)):
                narration_retry += 1
                guard_retry_pending = True
                guard_retry_buf.clear()
                messages.append_batch(driver.build_guard_followup(result, _core.guard_locale(runner.locale).narration_nudge))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # 意图守卫（B）：宣告「我这就去查/建/改…」却本轮零工具 → 逼它当场做（_core._announces_intent 已排除问句/征询）。只追一次。
            if (not round_tool_called and not verify_mode and intent_retry < 1
                    and _core._announces_intent(_final_text, runner.locale)):
                intent_retry += 1
                guard_retry_pending = True
                guard_retry_buf.clear()
                messages.append_batch(driver.build_guard_followup(result, _core.guard_locale(runner.locale).intent_nudge))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # 句末冒号是通用的未完结信号，不限定固定开头；续写时允许模型补完说明，
            # 若用户请求需要工具，则提醒中明确要求实际调用。只自动续一次。
            if (not round_tool_called and not verify_mode and colon_retry < 1
                    and _core._ends_with_colon(_final_text)):
                colon_retry += 1
                colon_retry_pending = True
                guard_retry_pending = True
                guard_retry_buf.clear()
                messages.append_batch(driver.build_guard_followup(
                    result, _core.guard_locale(runner.locale).colon_nudge,
                ))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # 若 provider 将显式决策放进 RoundResult，或模型只返回纯进度占位话术，
            # 本轮都不能作为最终回复结束。当前内置驱动的 requires_tools 由 tool_calls
            # 推导，保留该分支供支持显式决策的 provider 适配器使用。
            if (not any_tool_called and not verify_mode and tool_intent_retry < 1
                    and (_requires_tools is True or _core._is_tool_progress_only(_final_text, runner.locale))):
                tool_intent_retry += 1
                guard_retry_pending = True
                guard_retry_buf.clear()
                messages.append_batch(driver.build_guard_followup(result, _core.guard_locale(runner.locale).tool_required_nudge))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # P3 决策守卫：用户明确要改、模型零工具却用「不用改/已合理」驳回 → 逼它执行或问清，别擅自不做。
            if (not any_tool_called and not verify_mode and decision_retry < 1
                    and _core._is_decision_dodge(_user_req, _final_text, runner.locale)):
                decision_retry += 1
                guard_retry_pending = True
                guard_retry_buf.clear()
                messages.append_batch(driver.build_guard_followup(result, _core.guard_locale(runner.locale).decision_nudge))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # 即时复查时，前面还没有生成过最终说明；保留最终收束轮的确认给用户，
            # 复查过程中的文字仍然一直缓冲、不显示。
            if verify_mode and verify_queried and _final_text.strip():
                async for _line in _core.genstream.typed_stream(_final_text):
                    yield _line

            # 反思快照捕获（PRD-LLM-27 §6.1）：只在成功收尾处捕获，进程内登记供
            # 内联冲刷的 append_reuse 反思消费；失败/异常静默跳过，快照缺失时
            # 反思自然回落 standalone，绝不影响主流程。
            try:
                from agent.context.reflection_snapshot import capture_reflection_snapshot
                capture_reflection_snapshot(
                    user_id=user_id, session_id=session_id, run_id=run_id, ai=ai,
                    system_prompt=system_text or "", tools=getattr(ctx, "tools", None),
                    messages=messages, reply_text=_final_text,
                )
            except Exception as exc:
                _core.diag_log("agent.context.reflection_snapshot.capture", exc)

            # 正文已经确定后立即结束本轮；90% 压缩已在 provider round 返回后同步完成。
            yield f"data: {_core.json.dumps({'type': '_usage', 'input': total_in, 'context_input': run_context_usage, 'output': total_out, 'cache_read': total_cache, 'cache_write': total_cache_write})}\n\n"
            if reasoning_state is not None:
                await reasoning_state.completed()
            return

        # 核实预算耗尽的兜底收尾：无交互通道、弹窗过期或用户未选继续时落到这里。
        # 最后一轮可能刚完成工具调用，还没有机会生成自然语言收尾；不能让 runner
        # 把这个正常的安全停止误判成“工具结果已返回，但后续回复没有完成”。
        # 核实阶段的过程文字仍然只留在缓冲区，不能在这里泄漏给用户。
        if (
            not unlimited_mode
            and runner.max_verify_rounds is not None
            and verify_rounds >= runner.max_verify_rounds
        ):
            fallback = "已提交前面成功执行的调整；核实轮次已达到上限，未完成的步骤请重新发起。"
            async for _line in _core.genstream.typed_stream(fallback):
                yield _line
            yield f"data: {_core.json.dumps({'type': '_usage', 'input': total_in, 'context_input': run_context_usage, 'output': total_out, 'cache_read': total_cache, 'cache_write': total_cache_write})}\n\n"
            if reasoning_state is not None:
                await reasoning_state.completed()
            return
