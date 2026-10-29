"""Agent Loop 阶段编排入口（PRD-LLM-25 LLM25-013）。

`run_loop` 是 `core.LLMRunner._run_loop` 的实现体；core 保留同名方法做兼容
转发（LoopScope hooks 按类属性替换 `LLMRunner._run_loop`，签名不变）。循环体
经 `_core.` 前缀引用 core 命名空间里的常量与兼容别名——这保证旧测试
`monkeypatch.setattr(core, "_stream_round")` 在迁移后仍然生效。
"""
from __future__ import annotations

from functools import wraps
import asyncio
import json
import logging
import time
from typing import Any, AsyncGenerator, Awaitable, Callable
from uuid import uuid4

from agent import core as _core
from agent.context.assembly.area import MessageArea
from agent.errors import describe_llm_error
from agent.loop.context_runtime import ContextRuntime
from agent.loop.events import EventSequencer
from agent.loop.interaction_runtime import InteractionBindings, InteractionRuntime
from agent.loop.reply_runtime import ReplyDecisionBindings, ReplyRuntime, ReplyState
from agent.loop.round_runtime import ProviderRoundRuntime
from agent.loop import watchdog as _watchdog

_parallel_traj_log = logging.getLogger("agent.traj")

def _gate_violation_payload(reason: str) -> dict[str, Any]:
    """不符合本轮回复选择状态的工具调用错误。"""
    from agent.im.auto_reply import GATE_SILENT_REASON

    return {
        "error": reason,
        "next_action": (
            "本轮已选择静默，停止工具调用。"
            if reason == GATE_SILENT_REASON
            else "本轮已经输出回复正文，继续完成回复，不要再选择不回复。"
        ),
    }


def _log_tool_batch_observation(event: dict[str, Any]) -> None:
    """只输出允许的低敏度批次汇总字段。"""
    safe_fields = {
        "mode", "calls", "reason", "elapsed_ms", "succeeded", "failed", "cancelled",
        "isolated_invalid",
    }
    payload = {key: value for key, value in event.items() if key in safe_fields}
    payload.update(t="loop", event="tool_batch")
    _parallel_traj_log.info(json.dumps(payload, ensure_ascii=False))

def _allow_tool_images(model_cfg: Any) -> bool:
    """判断工具读回的图片能否继续交给本轮实际模型。"""
    from agent.media import images
    # 与当前用户附件 resolve_for_message 使用同一套显式配置/能力判断，不能只看
    # provider capability snapshot：用户手动开启 image 时 snapshot 可能仍未探测。
    return images.image_ready(model_cfg)


def _llm_diagnostic_tag(value: Any) -> str:
    text = str(value or "unknown")[:80]
    return "".join(char for char in text if char.isalnum() or char in "._-:") or "unknown"


def _llm_diagnostic_context(run_id: str, round_id: str, ai: Any, driver: Any, ctx: Any) -> str:
    """构造不含 prompt、工具参数、响应正文或凭据的 provider 诊断关联信息。"""

    budget = getattr(ctx, "max_tokens", getattr(ctx, "max_output_tokens", None))
    try:
        budget = max(0, int(budget)) if budget is not None else "unknown"
    except (TypeError, ValueError):
        budget = "unknown"
    return (
        f"agent.llm.call run_id={_llm_diagnostic_tag(run_id)} round={_llm_diagnostic_tag(round_id)} "
        f"provider={_llm_diagnostic_tag(getattr(ai, 'provider', None))} "
        f"model={_llm_diagnostic_tag(getattr(ai, 'model', None) or getattr(ctx, 'model', None))} "
        f"format={_llm_diagnostic_tag(getattr(driver, 'api_format', None))} output_token_budget={budget}"
    )


def _record_provider_round_diagnostic(
    *, run_id: str, round_id: str, ai: Any, driver: Any, ctx: Any, result: Any,
) -> None:
    """只记录截断、不完整或空结果等异常轮次的无内容诊断字段。"""
    finish_reason = str(result.finish_reason or "").lower()
    incomplete_reason = str(result.incomplete_reason or "").lower()
    if not (
        incomplete_reason
        or finish_reason in {"length", "max_tokens", "incomplete", "failed"}
        or (result.output_token_budget and result.usage_out >= result.output_token_budget)
        or (not result.text.strip() and not result.tool_calls)
    ):
        return

    from app.core.redaction import diag_log_raw
    diag_log_raw(
        "agent.llm.round_incomplete",
        json.dumps({
            "run_id": run_id,
            "round_id": round_id,
            "provider": _llm_diagnostic_tag(getattr(ai, "provider", None)),
            "model": _llm_diagnostic_tag(getattr(ai, "model", None) or getattr(ctx, "model", None)),
            "api_format": _llm_diagnostic_tag(driver.api_format),
            "output_token_budget": result.output_token_budget,
            "output_tokens": int(result.usage_out or 0),
            "finish_reason": result.finish_reason,
            "incomplete_reason": result.incomplete_reason,
            "has_text": bool(result.text.strip()),
            "tool_call_count": len(result.tool_calls or []),
        }, ensure_ascii=False, separators=(",", ":")),
    )


def _with_provider_client_scope(run_func):
    """在流式生成器每次推进时绑定同一 run scope，兼容跨 Task 消费。"""
    @wraps(run_func)
    async def wrapped(*args, **kwargs):
        from agent.providers.client_pool import provider_client_pool

        scope = provider_client_pool.new_run_scope()
        inner = run_func(*args, **kwargs)
        try:
            while True:
                try:
                    with provider_client_pool.activate(scope):
                        event = await inner.__anext__()
                except StopAsyncIteration:
                    break
                yield event
        finally:
            try:
                with provider_client_pool.activate(scope):
                    await inner.aclose()
            finally:
                provider_client_pool.finish_run_scope(scope)

    return wrapped


async def run_loop(
    runner: Any,
    driver: Any,
    user_id: Any,
    messages: MessageArea,
    ai: Any,
    system_text: str | None,
    *,
    session_id: int | None = None,
    session: Any = None,
    on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    reasoning_state: Any = None,
) -> AsyncGenerator[str, None]:
        """工具调用/核实阶段状态机/三条防幻觉守卫/空回复兜底——Anthropic 和
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
        if not isinstance(messages, MessageArea):
            raise TypeError("Agent loop 只接受 MessageArea")
        messages.reasoning_state = reasoning_state
        # 每轮对话最多允许三次 read_file 调用包含网络图片；历史附件不占用该额度。
        from agent.tools.media_reader import reset_remote_image_read_budget
        reset_remote_image_read_budget()
        goal_mode = _core._goal_mode_enabled(session)
        if goal_mode:
            if system_text:
                system_text = f"{system_text}{_core._GOAL_POLICY}"
            else:
                if hasattr(messages, "insert_request_message"):
                    messages.insert_request_message(
                        0, {"role": "system", "content": _core._GOAL_POLICY.strip()},
                    )
                else:
                    messages.insert(0, {"role": "system", "content": _core._GOAL_POLICY.strip()})
        from agent.tools import registry as tool_registry
        tool_snapshot = tool_registry.snapshot_with_extras(tuple(runner.dynamic_tools.values()), model_cfg=ai)
        from agent.context.canonical_tool_history import refresh_model_tool_schemas
        refresh_model_tool_schemas(messages, tool_snapshot, runner.tool_names)
        initial_tool_names = runner.tool_names
        if (
            runner.capability_context is not None
            and not getattr(runner.capability_context, "metadata_only", False)
        ):
            initial_tool_names = list(runner.capability_context.select_for_messages(messages).tool_names)
        initial_tool_names = runner._provider_tool_names(initial_tool_names)
        reply_gate = getattr(runner, "group_reply_gate", None)
        from agent.im.auto_reply import GROUP_NO_REPLY_TOOL
        reply_tool_name = GROUP_NO_REPLY_TOOL
        if reply_gate is not None:
            if reply_tool_name not in initial_tool_names:
                initial_tool_names = [*initial_tool_names, reply_tool_name]
        current_tool_names = list(initial_tool_names)
        client, ctx = driver.prepare(
            initial_tool_names, ai, messages, system_text, tool_snapshot=tool_snapshot,
        )
        if getattr(ctx, "supports_active_cache", False):
            from agent.context.cache_state import CacheState

            session_context = getattr(session, "session_context", None)
            session_context = session_context if isinstance(session_context, dict) else {}
            ctx.cache_state = CacheState.from_session_anchor(
                session_context.get("provider_cache_anchor"),
                provider=str(getattr(ctx.adapter, "name", "unknown")),
                api_format=str(getattr(ctx.adapter, "api_format", "anthropic")),
                model=str(ctx.model),
                strategy="multi",
            )
        if reasoning_state is not None:
            await reasoning_state.prepared(driver, ctx)
        # 只把能力上下文挂到 provider request context，供 LoopScope 记录脱敏指标；
        # 不把目录或用户消息复制进 driver。
        if runner.capability_context is not None:
            ctx.capability_context = runner.capability_context
        loaded_skill_ids = _core._loaded_skill_ids(messages)
        # 当前用户消息是本轮 run 的保护边界。压缩时只处理它之前的历史，
        # 工具调用/结果追加后仍通过对象身份找到同一个起点。
        _run_conversation = messages.provider_projection().to_messages()
        _run_start_index = _core.last_user_index(_run_conversation)
        run_start_index = _run_start_index if _run_start_index is not None else max(0, len(_run_conversation) - 1)
        reply_state = ReplyState()
        responses_fallback_used = False
        reply_runtime = ReplyRuntime(
            state=reply_state,
            bindings=ReplyDecisionBindings(
                looks_like_narration=_core._looks_like_narration,
                announces_intent=_core._announces_intent,
                ends_with_colon=_core._ends_with_colon,
                is_tool_progress_only=_core._is_tool_progress_only,
                is_decision_dodge=_core._is_decision_dodge,
                guard_locale=_core.guard_locale,
            ),
        )
        _request_conversation = messages.provider_projection().to_messages()
        _request_user_index = _core.last_user_index(_request_conversation)
        _user_req = (
            _core.user_text_from_message(_request_conversation[_request_user_index])
            if _request_user_index is not None else ""
        )
        decision_guard_enabled = False
        if session_id is not None:
            from agent.interactions.preferences import decision_guard_enabled as read_decision_guard
            decision_guard_enabled = await read_decision_guard(user_id)
        # 初始用户图片只需要首轮完整发送；首轮结束后折叠成稳定文本，避免下一轮和下一次
        # run 在同一历史位置分别出现 base64 与占位文本，导致 provider 从图片处断缓存。
        initial_volatile_indices = _core.loop_drivers._volatile_message_indices(messages)
        # 自我核实阶段：一旦进入就持续到收尾（含其查证用的 get_* 轮）。期间模型文字先缓冲——
        # 干净通过则整段丢弃（不把"已核实…"那种重复确认刷给用户）；发现并补做了，才在补做那轮发一次说明。
        verify_mode = False; verify_queried = False
        finalize_pending = False
        # 破坏性工具的用户确认授权存在服务端（Redis）：确认后运行侧按原参数重投，
        # 确认门自动命中放行；运行时不做任何凭证续接，也不让模型再调用一次。
        # 压缩判定使用最近一次 provider 请求的 context input，不能跨轮累加或沿用高水位。
        run_context_usage_peak = 0
        run_id = f"run-{_core.uuid4().hex[:16]}"
        from agent.runtime.cancellation import (
            RunCancellation, RunCancellationRequested, register_current_run,
            set_current_cancellation,
        )
        # Agent loop 内部 run_id 与 Gateway 的 owner_run_id 是不同标识；当前执行
        # 会话由 session gate 保证唯一，因此取消检查按 session 读取共享标记。
        cancellation = RunCancellation(session_id)
        set_current_cancellation(cancellation)
        register_current_run(session_id, run_id)
        run_state = _core._RunState(run_id=run_id, session_id=session_id)
        event_sequencer = EventSequencer(run_state.run_id, encoder=_core.encode_event)
        context_runtime = ContextRuntime(
            messages=messages,
            run_state=run_state,
            ai=ai,
            system_text=system_text,
            session_id=session_id,
            run_start_index=run_start_index,
            branch_tools=getattr(ctx, "tools", None),
            reasoning_state=reasoning_state,
        )

        def stream_event(event_type: str, **payload) -> str:
            """统一给兼容 SSE 事件补上可追踪身份；不写入用户正文或工具参数日志。"""
            event = event_sequencer.next_event(event_type, **payload)
            run_state.event_seq = event_sequencer.seq
            return event

        while True:
            if reply_gate is not None:
                from agent.im.auto_reply import ReplyChoice

                if (
                    runner.capability_context is not None
                    and not getattr(runner.capability_context, "metadata_only", False)
                ):
                    selected = runner.capability_context.select_for_messages(messages).tool_names
                else:
                    selected = tuple(runner.tool_names)
                current_tool_names = list(runner._provider_tool_names(list(selected)))
                if reply_gate.choice is ReplyChoice.PENDING:
                    if reply_tool_name not in current_tool_names:
                        current_tool_names.append(reply_tool_name)
                else:
                    current_tool_names = [
                        name for name in current_tool_names if name != reply_tool_name
                    ]
            scheduled_round_limit = getattr(runner, "round_limit_per_run", None)
            if scheduled_round_limit is not None and run_state.round_number >= scheduled_round_limit:
                _core._log.warning(
                    "[core] 定时任务模型轮次达到上限：used=%s limit=%s",
                    run_state.round_number, scheduled_round_limit,
                )
                yield f"data: {_core.json.dumps({'type': 'error', 'detail': f'定时任务达到模型轮次上限（{scheduled_round_limit} 轮）'}, ensure_ascii=False)}\n\n"
                return
            if verify_mode:
                run_state.verify_rounds += 1
            else:
                run_state.task_rounds += 1
            # 轮间检查与流式等待共用同一取消控制器；长流由 iterate 即时中断。
            if await cancellation.is_requested():
                yield stream_event("_cancelled", remote_status_unknown=cancellation.remote_status_unknown)
                return

            result = None
            run_state.next_round()
            round_id = f"round-{run_state.round_number}"
            diagnostic_context = _llm_diagnostic_context(run_id, round_id, ai, driver, ctx)
            run_state.round_start_indices.append((
                run_state.round_number,
                len(messages.provider_projection()),
            ))
            yield stream_event("round_start", round_id=round_id)
            _verify_buf = []   # 核实轮缓冲区：先攒着，回合结束按"有没有补做"决定 flush 还是丢弃
            _reply_gate_buf = []
            try:
                round_runtime = ProviderRoundRuntime(
                    runner=runner,
                    driver=driver,
                    client=client,
                    context=ctx,
                    ai=ai,
                    messages=messages,
                    system_text=system_text,
                    tool_snapshot=tool_snapshot,
                    tool_names=current_tool_names,
                    stream_round=_core._stream_round,
                    reasoning_state=reasoning_state,
                    responses_fallback_used=responses_fallback_used,
                )
                round_events = round_runtime.stream()
                try:
                    async for emission in cancellation.iterate(round_events):
                        if emission.kind == "done":
                            result = emission.value
                            continue
                        if emission.kind == "retry":
                            retry = emission.value
                            _watchdog.record_provider_retry(
                                run_id=run_id,
                                round_number=run_state.round_number,
                                attempt=retry.get("attempt"),
                                error_kind=retry.get("error_kind"),
                            )
                            yield stream_event(
                                "retry",
                                attempt=retry.get("attempt"),
                                max_retries=retry.get("max_retries"),
                                next_retry_in=retry.get("next_retry_in"),
                                error_kind=retry.get("error_kind"),
                            )
                            continue
                        token = emission.value
                        if verify_mode:
                            _verify_buf.append(token)
                        elif goal_mode:
                            # 等待完成标记判定，避免把内部标记流给用户。
                            pass
                        elif reply_gate is not None and reply_gate.choice is ReplyChoice.PENDING:
                            # 暂存到完整 provider 结果，确认没有选择静默后再决定是否展示。
                            _reply_gate_buf.append(token)
                        elif reply_state.guard_retry_pending:
                            reply_state.guard_retry_buf.append(token)
                        else:
                            yield stream_event("token", content=token, round_id=round_id)
                finally:
                    await round_events.aclose()
                    driver = round_runtime.driver
                    client = round_runtime.client
                    ctx = round_runtime.context
                    current_tool_names = round_runtime.tool_names
                    responses_fallback_used = round_runtime.responses_fallback_used
            except RunCancellationRequested:
                yield stream_event("_cancelled", remote_status_unknown=cancellation.remote_status_unknown)
                return
            except _core.RetryableError as e:
                if reasoning_state is not None:
                    await reasoning_state.failed("provider_rejected")
                from agent.context.budget import is_context_overflow_error
                overflow = is_context_overflow_error(e) or is_context_overflow_error(e.cause) if e.cause else is_context_overflow_error(e)
                if overflow and run_state.hard_budget_retries < 1:
                    yield stream_event("_context_compaction", phase="started", reason="provider_overflow")
                    if await context_runtime.compact_now():
                        run_state.hard_budget_retries += 1
                        _event = context_runtime.take_event()

                        if _event:
                            yield f"data: {_core.json.dumps(_event, ensure_ascii=False)}\n\n"
                        if verify_mode:
                            run_state.verify_rounds -= 1
                        else:
                            run_state.task_rounds -= 1
                        _core._log.warning("[core] provider overflow 后完成历史压缩，重试当前 round")
                        continue
                    if await context_runtime.apply_deterministic_fallback("provider_overflow_fallback"):
                        _event = context_runtime.take_event()

                        if _event:
                            yield f"data: {_core.json.dumps(_event, ensure_ascii=False)}\n\n"
                        run_state.hard_budget_retries += 1
                        if verify_mode:
                            run_state.verify_rounds -= 1
                        else:
                            run_state.task_rounds -= 1
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
                attempts_done = int(getattr(e, "attempt", 0) or 0)
                error_info = describe_llm_error(
                    e, attempts=attempts_done, diagnostic_context=diagnostic_context,
                )
                yield f"data: {_core.json.dumps(error_info.as_event(), ensure_ascii=False)}\n\n"
                return
            except Exception as e:
                from app.core.errors import AppError
                if isinstance(e, AppError):
                    if reasoning_state is not None:
                        await reasoning_state.failed(e.code)
                    yield f"data: {_core.json.dumps({'type': 'error', 'detail': e.public_message}, ensure_ascii=False)}\n\n"
                    return
                if reasoning_state is not None:
                    await reasoning_state.failed("provider_rejected")
                from agent.context.budget import is_context_overflow_error
                if is_context_overflow_error(e) and run_state.hard_budget_retries < 1:
                    yield stream_event("_context_compaction", phase="started", reason="provider_overflow")
                    if await context_runtime.compact_now():
                        run_state.hard_budget_retries += 1
                        _event = context_runtime.take_event()

                        if _event:
                            yield f"data: {_core.json.dumps(_event, ensure_ascii=False)}\n\n"
                        if verify_mode:
                            run_state.verify_rounds -= 1
                        else:
                            run_state.task_rounds -= 1
                        _core._log.warning("[core] provider overflow 后完成历史压缩，重试当前 round")
                        continue
                    if await context_runtime.apply_deterministic_fallback("provider_overflow_fallback"):
                        _event = context_runtime.take_event()

                        if _event:
                            yield f"data: {_core.json.dumps(_event, ensure_ascii=False)}\n\n"
                        run_state.hard_budget_retries += 1
                        if verify_mode:
                            run_state.verify_rounds -= 1
                        else:
                            run_state.task_rounds -= 1
                        _core._log.warning("[core] provider 返回上下文超量，执行一次确定性截断重试")
                        continue
                    yield stream_event("_context_compaction", phase="completed", applied=False,
                                       reason="not_applied")
                # 已吐 token 后中途失败或其他未预期异常按未知错误处理。错误描述器会把原始异常
                # 写入受限诊断日志，并将同一诊断编号返回给用户；上下文保留 provider 与 api_format。
                _core._log.error("LLM 调用中途出错：%s", type(e).__name__)
                error_info = describe_llm_error(
                    e,
                    diagnostic_context=diagnostic_context,
                )
                yield f"data: {_core.json.dumps(error_info.as_event(), ensure_ascii=False)}\n\n"
                return

            run_state.total_usage_in += result.usage_in
            run_state.total_usage_out += result.usage_out
            run_state.total_cache_read += result.cache_tokens
            run_state.total_cache_write += result.cache_write_tokens
            if getattr(ctx, "supports_active_cache", False):
                messages.remember_provider_cache_anchor(ctx.cache_state.to_session_anchor())
            run_state.run_context_usage = int(_core._provider_context_usage(driver, result) or 0)
            run_context_usage_peak = max(run_context_usage_peak, run_state.run_context_usage)
            if reasoning_state is not None:
                await reasoning_state.round_finished(driver, ctx, result, round_id)
            private_reasoning = str(getattr(getattr(result, "raw", None), "reasoning", "") or "")
            if private_reasoning and result.tool_calls:
                messages.private_reasoning_by_call[result.tool_calls[0].id] = private_reasoning
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
                output_token_budget=result.output_token_budget,
                finish_reason=result.finish_reason,
                incomplete_reason=result.incomplete_reason,
            )
            _record_provider_round_diagnostic(
                run_id=run_id, round_id=round_id, ai=ai, driver=driver, ctx=ctx, result=result,
            )

            finish_reason = str(result.finish_reason or "").lower()
            round_incomplete = bool(result.incomplete_reason) or finish_reason in {
                "length", "max_tokens", "incomplete",
            }
            if round_incomplete:
                if reasoning_state is not None:
                    await reasoning_state.failed("provider_incomplete")
                detail = (
                    "模型响应不完整，未执行其中的工具调用。请缩短请求或调高输出 Token 预算后重试。"
                    if result.tool_calls else
                    "模型输出未完整结束；当前内容可能被截断，请继续追问或调高输出 Token 预算。"
                )
                yield f"data: {_core.json.dumps({'type': 'error', 'detail': detail}, ensure_ascii=False)}\n\n"
                return

            _requires_tools = result.requires_tools
            if _requires_tools is None:
                _requires_tools = bool(result.tool_calls)
            _watchdog.record_round_result(
                run_id=run_id,
                round_number=run_state.round_number,
                tool_calls=result.tool_calls,
                requires_tools=_requires_tools,
                verify_mode=verify_mode,
                goal_mode=goal_mode,
                task_rounds=run_state.task_rounds,
                verify_rounds=run_state.verify_rounds,
                tool_calls_used=run_state.tool_call_count,
            )
            # 行动意图守卫判断的是当前模型轮次，而不是整个 run 是否曾经调用过工具。
            # 前面轮次可能已经查过数据，但本轮仍可能只输出“我继续处理：”而没有实际调用；
            # 这种情况下仍必须触发守卫，不能被 any_tool_called 这个历史状态挡住。
            round_tool_called = bool(result.tool_calls)

            if initial_volatile_indices:
                _core.loop_drivers._collapse_volatile_messages(messages, initial_volatile_indices)
                initial_volatile_indices = set()

            # 统一策略：每个 provider round 返回后都检查实际上下文用量，
            # 最终回复轮也必须经过同一条 90% 压缩路径。
            if context_runtime.usage_compaction_due():
                yield stream_event("_context_compaction", phase="started", reason="usage_threshold")
                if await context_runtime.compact_after_usage_threshold():
                    _event = context_runtime.take_event()

                    if _event:
                        yield f"data: {_core.json.dumps(_event, ensure_ascii=False)}\n\n"
                else:
                    yield stream_event("_context_compaction", phase="completed", applied=False,
                                       reason="not_applied")

            if reply_gate is not None and reply_gate.choice is ReplyChoice.PENDING:
                # 正文在拒绝门定案前保持缓冲；纯工具轮只用于收集判断依据，
                # 继续保留拒绝机会，只有实际输出正文才锁定为回复。
                resolved_targets = []
                for call in result.tool_calls:
                    target, _arguments, resolve_error = _core._resolve_tool_call(
                        getattr(call, "name", None), getattr(call, "input", None),
                    )
                    if resolve_error is None:
                        resolved_targets.append(target)
                no_reply_selected_in_round = reply_tool_name in resolved_targets
                buffered_reply = result.text or "".join(_reply_gate_buf)
                if not no_reply_selected_in_round and buffered_reply.strip():
                    reply_gate.choice = ReplyChoice.REPLY
                    if not result.text:
                        result.text = buffered_reply
                    if buffered_reply.strip() and not verify_mode and not goal_mode:
                        yield stream_event("token", content=buffered_reply, round_id=round_id)

            if result.tool_calls:
                gate_violations: list[tuple[int, Any, str, str]] = []
                no_reply_selected_in_batch = False
                if reply_gate is not None:
                    from agent.im.auto_reply import GATE_SILENT_REASON, gate_call_violation_reason

                    resolved_calls = []
                    for call in result.tool_calls:
                        resolved, _arguments, resolve_error = _core._resolve_tool_call(
                            getattr(call, "name", None), getattr(call, "input", None),
                        )
                        resolved_calls.append((resolved, resolve_error))
                    no_reply_selected_in_batch = (
                        reply_gate.choice is ReplyChoice.PENDING
                        and any(error is None and name == reply_tool_name for name, error in resolved_calls)
                    )

                    for index, call in enumerate(result.tool_calls):
                        resolved, resolve_error = resolved_calls[index]
                        if resolve_error is not None:
                            continue
                        reason = gate_call_violation_reason(reply_gate, resolved)
                        if no_reply_selected_in_batch and resolved != reply_tool_name:
                            reason = GATE_SILENT_REASON
                        if reason is not None:
                            gate_violations.append((index, call, resolved, reason))

                if gate_violations:
                    from app.core.redaction import diag_log_raw
                    diag_log_raw(
                        "agent.loop.group_reply_tool_call_blocked",
                        f"run_id={run_id} round_id={round_id} calls={len(gate_violations)}",
                    )
                reply_state.tool_round_started()  # 本轮真调了工具 → narration 兜底不触发
                # 核实阶段首次补做（本轮调了增删改）→ 把"发现漏了X，补一下"说明发一次；之后的核对文字仍静默
                dispatched = []
                run_state.pending = None
                agent_settings = getattr(getattr(runner, "settings", None), "agent", None)
                parallel_cancelled = False
                for call_index, tool_call in enumerate(result.tool_calls):
                    if not getattr(tool_call, "id", None):
                        tool_call.id = f"{round_id}-tool-{call_index + 1}"
                parallel_enabled = bool(
                    getattr(agent_settings, "parallel_tool_execution_enabled", False)
                )
                if parallel_enabled:
                    parallel_plan, serial_plan = _core._partition_tool_calls(
                        result.tool_calls, tool_snapshot,
                    )
                else:
                    parallel_plan, serial_plan = [], list(enumerate(result.tool_calls))

                # 不回复选择与业务工具同批时，按 provider 原始批次统一拦截；不能
                # 因为串行执行时静默工具先改了 gate 状态而放过后续业务调用。
                gate_violation_reasons: dict[str, str] = {}
                for _index, _call, resolved, reason in gate_violations:
                    gate_violation_reasons.setdefault(resolved, reason)

                gate_protocol_errors: dict[int, tuple[str, str]] = {}
                parallel_local = {
                    original: local
                    for local, (original, _call, _target, _arguments)
                    in enumerate(parallel_plan)
                }
                for original, _call, resolved, reason in gate_violations:
                    local = parallel_local.get(original)
                    if local is None:
                        continue
                    gate_protocol_errors[local] = (resolved, _core.json.dumps(
                        _gate_violation_payload(reason), ensure_ascii=False,
                    ))

                def gate_resolve_tool_call(raw_name, raw_input):
                    """串行批次中预先判定并隔离与不回复选择同批的业务调用。"""
                    target, arguments, resolve_error = _core._resolve_tool_call(
                        raw_name, raw_input,
                    )
                    if resolve_error is not None:
                        return target, arguments, resolve_error
                    reason = gate_violation_reasons.get(target)
                    if reason is None:
                        return target, arguments, None
                    return target, arguments, _gate_violation_payload(reason)

                if len(result.tool_calls) > 1 and not parallel_enabled:
                    _log_tool_batch_observation({
                        "mode": "serial",
                        "calls": len(result.tool_calls),
                        "reason": "parallel_disabled",
                    })
                indexed_dispatched: dict[int, tuple[Any, Any]] = {}
                terminal_events: dict[int, dict[str, Any]] = {}
                call_indexes_by_id = {
                    getattr(call, "id", None): index
                    for index, call in enumerate(result.tool_calls)
                }
                parallel_indexes = [index for index, _call, _target, _arguments in parallel_plan]
                if parallel_plan:
                    from agent.loop.tool_round import ParallelToolBatchRuntime, ParallelToolBindings

                    parallel_runtime = ParallelToolBatchRuntime(
                        tool_calls=[call for _index, call, _target, _arguments in parallel_plan],
                        parallel_batch=[
                            (local_index, call, target, arguments)
                            for local_index, (_index, call, target, arguments)
                            in enumerate(parallel_plan)
                        ],
                        protocol_errors=gate_protocol_errors,
                        runner=runner,
                        user_id=user_id,
                        session_id=session_id,
                        session=session,
                        run_id=run_id,
                        round_id=round_id,
                        verify_mode=verify_mode,
                        tool_snapshot=tool_snapshot,
                        loaded_skill_ids=loaded_skill_ids,
                        max_concurrency=getattr(agent_settings, "parallel_tool_max_concurrency", 5),
                        bindings=ParallelToolBindings(
                            set_tool_state=_core._im_set_tool_state,
                            dispatch_in_session=_core._dispatch_in_session,
                            copy_skill_state=_core._copy_skill_state_for_parallel,
                            run_parallel_dispatches=_core._run_parallel_dispatches,
                            dispatch_cancelled_type=_core._ParallelDispatchCancelled,
                            is_successful_result=_core._is_successful_tool_result,
                            diag_log=_core.diag_log,
                            log_batch=_log_tool_batch_observation,
                        ),
                        run_state=run_state,
                        on_interaction=on_interaction,
                    )
                    async for emission in parallel_runtime.run():
                        if emission.kind == "event":
                            payload = emission.value
                            if payload["type"] == "tool_call" and payload.get("status") != "running":
                                run_state.tool_call_count += 1
                            if payload["type"] == "tool_done":
                                call_index = call_indexes_by_id.get(payload.get("tool_call_id"))
                                if call_index is not None:
                                    terminal_events[call_index] = payload
                                    continue
                            event_type = payload["type"]
                            event_payload = {key: value for key, value in payload.items() if key != "type"}
                            yield stream_event(event_type, **event_payload)
                        elif emission.kind == "artifact":
                            yield _core._artifact_sse(emission.value)
                        elif emission.kind == "complete":
                            indexed_dispatched.update(
                                (original_index, item)
                                for original_index, item in zip(
                                    parallel_indexes, emission.value.dispatched,
                                )
                            )
                            parallel_cancelled = emission.value.cancelled

                serial_indexes = [index for index, _call in serial_plan]
                if serial_plan and parallel_cancelled:
                    for original_index, call in serial_plan:
                        target, _arguments, _error = _core._resolve_tool_call(
                            getattr(call, "name", None), getattr(call, "input", None),
                        )
                        label = runner._label(target)
                        if verify_mode:
                            label = runner._label("_verify_prefix", "复查 · ") + label
                        tool_call_id = getattr(call, "id")
                        cancelled_result = _core.json.dumps(
                            {"error": "工具调用已取消。"}, ensure_ascii=False,
                        )
                        indexed_dispatched[original_index] = (call, cancelled_result)
                        run_state.tool_call_count += 1
                        yield stream_event(
                            "tool_call", round_id=round_id, tool_call_id=tool_call_id,
                            name=target, label=label, input={}, verify=verify_mode,
                            status="cancelled",
                        )
                        terminal_events[original_index] = {
                            "type": "tool_done", "round_id": round_id,
                            "tool_call_id": tool_call_id, "name": target, "label": label,
                            "verify": verify_mode, "status": "cancelled",
                            "result": cancelled_result,
                        }
                elif serial_plan:
                    from agent.loop.tool_round import SerialToolBatchRuntime, SerialToolBindings

                    serial_runtime = SerialToolBatchRuntime(
                        tool_calls=[call for _index, call in serial_plan],
                        runner=runner,
                        run_state=run_state,
                        bindings=SerialToolBindings(
                            resolve_tool_call=gate_resolve_tool_call,
                            set_tool_state=_core._im_set_tool_state,
                            dispatch_in_session=_core._dispatch_in_session,
                            is_successful_result=_core._is_successful_tool_result,
                            json_dumps=_core.json.dumps,
                            json_loads=_core.json.loads,
                            pending_interaction_type=_core._PendingInteraction,
                            truncated_args_error=_core.loop_drivers.TOOL_ARGS_TRUNCATED_ERROR,
                        ),
                        user_id=user_id,
                        session_id=session_id,
                        session=session,
                        run_id=run_id,
                        round_id=round_id,
                        verify_mode=verify_mode,
                        tool_snapshot=tool_snapshot,
                        loaded_skill_ids=loaded_skill_ids,
                        on_interaction=on_interaction,
                    )
                    async for emission in serial_runtime.run():
                        if emission.kind == "event":
                            payload = emission.value
                            if parallel_plan and payload.get("type") == "tool_done":
                                call_index = call_indexes_by_id.get(payload.get("tool_call_id"))
                                if call_index is not None:
                                    terminal_events[call_index] = payload
                                    continue
                            event_type = payload.pop("type")
                            yield stream_event(event_type, **payload)
                        elif emission.kind == "artifact":
                            yield _core._artifact_sse(emission.value)
                        elif emission.kind == "complete":
                            indexed_dispatched.update(
                                (original_index, item)
                                for original_index, item in zip(
                                    serial_indexes, emission.value.dispatched,
                                )
                            )

                dispatched = [indexed_dispatched[index] for index in sorted(indexed_dispatched)]
                for call_index in sorted(terminal_events):
                    payload = terminal_events[call_index]
                    event_payload = {
                        key: value for key, value in payload.items() if key != "type"
                    }
                    yield stream_event("tool_done", **event_payload)

                # 只有工具实际成功才算取得进展：失败/等待确认的回执不能重置空回复额度。
                if any(
                    _core._is_successful_tool_result(tool_result)
                    for _tool_call, tool_result in dispatched
                ):
                    reply_state.tool_round_succeeded()

                from agent.context.assembly import MessageBatch
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
                        from agent.context.provider_conversation import ProviderConversation
                        from agent.runtime.loopscope_trace.state import record_anthropic_structure_probe
                        record_anthropic_structure_probe(
                            provider=getattr(getattr(ctx, "adapter", None), "name", ""),
                            model=getattr(ctx, "model", ""),
                            response_blocks=getattr(result, "raw", []),
                            provider_conversation=ProviderConversation(provider_round),
                        )
                    except Exception:
                        pass
                batch = MessageBatch.from_canonical_messages(
                    canonical_tool_round(result, dispatched),
                    metadata={"round_id": round_id},
                )
                if getattr(runner.capability_context, "fixed_adapter", False):
                    from agent.context.canonical_tool_history import (
                        SkillSchemaEvent, ToolDiscoveryEvent, append_event, tool_schema_event,
                    )
                    # canonical event 也先进入同一批次，不能在工具 round 提交后再单独
                    # 修改 history；否则下一次重建时消息粒度和顺序可能发生变化。
                    batch_history = [
                        entry.canonical_message for entry in messages.entries
                    ] + list(batch.canonical_messages)

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
                            skill_id = str((resolved_input or {}).get("id") or "").strip().upper()
                            resolved_skill = skill_id
                            skill_meta = getattr(runner.capability_context, "snapshot", None)
                            skill_meta = getattr(skill_meta, "skills", {}).get(resolved_skill)
                            if getattr(skill_meta, "kind", None) != "skill":
                                skill_meta = None
                            related = tuple(getattr(skill_meta, "related_tools", ()) or ())
                            if related:
                                add_event(SkillSchemaEvent(skill_id, related))
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
                if reply_gate is not None:
                    from agent.im.auto_reply import ReplyChoice

                    if reply_gate.choice is ReplyChoice.SILENT:
                        # 选择静默后不再发起后续 provider 请求；run 收尾会丢弃本轮内部工具历史。
                        if reasoning_state is not None:
                            await reasoning_state.completed()
                        yield stream_event(
                            "_usage",
                            input=run_state.total_usage_in,
                            context_input=run_context_usage_peak,
                            output=run_state.total_usage_out,
                            cache_read=run_state.total_cache_read,
                            cache_write=run_state.total_cache_write,
                        )
                        return
                if parallel_cancelled:
                    # 已完成调用保留实际结果；未完成调用用取消回执补齐 canonical 配对。
                    # 取消事件结束当前 Run，不能再把这批结果发给 Provider 续轮。
                    yield stream_event("_cancelled", remote_status_unknown=cancellation.remote_status_unknown)
                    return
                if run_state.pending is not None:
                    interaction_runtime = InteractionRuntime(
                        run_state=run_state,
                        messages=messages,
                        bindings=InteractionBindings(
                            classify_answer=_core.classify_interaction_answer,
                            replace_tool_result=_core._replace_tool_result,
                            pending_tool_signal=_core._pending_tool_signal,
                            closing_frames=_core._closing_frames,
                            dispatch_in_session=_core._dispatch_in_session,
                            tool_result_payload=_core._tool_result_payload,
                            is_successful_result=_core._is_successful_tool_result,
                            is_cancelled=cancellation.is_requested,
                            diag_log=_core.diag_log,
                        ),
                        user_id=user_id,
                        session_id=session_id,
                        session=session,
                        run_id=run_id,
                        round_id=round_id,
                        verify_mode=verify_mode,
                        tool_snapshot=tool_snapshot,
                        skill_state=loaded_skill_ids,
                        next_round=run_state.round_number + 1,
                        cancel_close_text=_core._CANCEL_CLOSE_TEXT,
                        on_interaction=on_interaction,
                    )
                    interaction_action = None
                    interaction_tool_succeeded = False
                    while run_state.pending is not None:
                        async for emission in interaction_runtime.resolve_pending():
                            if emission.kind == "event":
                                payload = emission.value
                                event_type = payload.pop("type", "tool_done")
                                if event_type == "tool_done" and payload.get("status") == "success":
                                    interaction_tool_succeeded = True
                                event_payload = {key: value for key, value in payload.items() if key != "type"}
                                yield stream_event(event_type, **event_payload)
                            elif emission.kind == "raw":
                                yield emission.value
                            elif emission.kind == "artifact":
                                yield _core._artifact_sse(emission.value)
                            elif emission.kind == "action":
                                interaction_action = emission.value
                        if interaction_action != "continue" or run_state.pending is None:
                            break
                        interaction_action = None
                    if interaction_action == "return":
                        return
                    if interaction_action == "continue":
                        if interaction_tool_succeeded:
                            reply_state.tool_round_succeeded()
                        continue
                # 工具结果已经入历史，直接进入下一轮。增删改工具不再自动注入复查提示；
                # 工具意图和失败回执守卫仍在本轮及下一轮生效。
                yield stream_event("_new_round", round_id=round_id, next_round=run_state.round_number + 1)
                continue

            # 核验提示已经要求模型在查询后直接总结；如果当前轮已经给出可交付的结果，
            # 不再重复发一轮最终收束请求。只有“我确认一下/已核实”这类过程播报才需要
            # 追加收束轮，避免它被直接展示给用户。
            if (verify_mode and verify_queried and not finalize_pending
                    and _core._is_verify_placeholder("".join(_verify_buf))):
                finalize_pending = True
                messages.append_batch(driver.build_followup(result, _core._FINALIZE_PROMPT))
                yield stream_event("_new_round", round_id=round_id, next_round=run_state.round_number + 1)
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
                    yield stream_event("_new_round", round_id=round_id, next_round=run_state.round_number + 1)
                    continue
            decision = reply_runtime.decide(
                final_text=_final_text, result=result,
                round_tool_called=round_tool_called, verify_mode=verify_mode,
                requires_tools=_requires_tools, user_request=_user_req,
                locale=runner.locale, decision_guard_enabled=decision_guard_enabled,
            )
            if decision.action == "retry":
                if decision.retry_kind == "empty":
                    messages.append_batch(driver.build_empty_retry(result))
                else:
                    messages.append_batch(driver.build_guard_followup(result, decision.prompt or ""))
                yield stream_event("_new_round", round_id=round_id, next_round=run_state.round_number + 1)
                continue
            if decision.action == "continue_checks":
                _final_text = decision.visible_text or ""
                async for _line in _core.genstream.typed_stream(_final_text):
                    yield _line
                decision = reply_runtime.decide(
                    final_text=_final_text, result=result,
                    round_tool_called=round_tool_called, verify_mode=verify_mode,
                    requires_tools=_requires_tools, user_request=_user_req,
                    locale=runner.locale, decision_guard_enabled=decision_guard_enabled,
                )
                if decision.action == "retry":
                    messages.append_batch(driver.build_guard_followup(result, decision.prompt or ""))
                    yield stream_event("_new_round", round_id=round_id, next_round=run_state.round_number + 1)
                    continue
            if decision.action == "complete_after_guard":
                if decision.visible_text:
                    async for _line in _core.genstream.typed_stream(decision.visible_text):
                        yield _line
                if reasoning_state is not None:
                    await reasoning_state.completed()
                yield f"data: {_core.json.dumps({'type': '_usage', 'input': run_state.total_usage_in, 'context_input': run_context_usage_peak, 'output': run_state.total_usage_out, 'cache_read': run_state.total_cache_read, 'cache_write': run_state.total_cache_write})}\n\n"
                return
            # 即时复查时，前面还没有生成过最终说明；保留最终收束轮的确认给用户，
            # 复查过程中的文字仍然一直缓冲、不显示。
            if verify_mode and verify_queried and _final_text.strip():
                async for _line in _core.genstream.typed_stream(_final_text):
                    yield _line

            # 反思快照捕获（PRD-LLM-27 §6.1）：只在成功收尾处捕获，进程内登记供
            # append_reuse 反思消费；失败/异常静默跳过，闲置 worker 可从持久历史重建最小输入。
            if reply_gate is None or reply_gate.choice is ReplyChoice.REPLY:
                try:
                    from agent.context.reflection_snapshot import capture_reflection_snapshot
                    capture_reflection_snapshot(
                        user_id=user_id, session_id=session_id, run_id=run_id, ai=ai,
                        system_prompt=system_text or "", tools=getattr(ctx, "tools", None),
                        messages=messages, reply_text=_final_text,
                        provider_context_input=run_state.run_context_usage or None,
                        provider_compacted=context_runtime.provider_compacted,
                    )
                except Exception as exc:
                    _core.diag_log("agent.context.reflection_snapshot.capture", exc)

            # 正文已经确定后立即结束本轮；90% 压缩已在 provider round 返回后同步完成。
            yield f"data: {_core.json.dumps({'type': '_usage', 'input': run_state.total_usage_in, 'context_input': run_context_usage_peak, 'output': run_state.total_usage_out, 'cache_read': run_state.total_cache_read, 'cache_write': run_state.total_cache_write})}\n\n"
            if reasoning_state is not None:
                await reasoning_state.completed()
            return


# 保持 run_loop 实现本身聚焦编排；边界包装只负责 provider client 的 run 租约。
run_loop = _with_provider_client_scope(run_loop)
