from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import uuid
from typing import Any

from .context import install_context_hooks
from .state import (
    _ScopeRun, _enabled, _finish_run, _now, _scope_run, get_trace,
    record_adapter_call, record_adapter_result, record_canonical_event_stats,
)
from .utils import (
    _classify_followup, _code_ref, _estimate_tokens, _extract_last_user,
    _jsonable, _prompt_digest, _round_result, _system_message_text,
    _cache_diagnostics,
)

_hooks_installed = False


def _tool_names_from_schemas(tools: Any) -> list[str]:
    """从 provider 已收到的 Schema 提取名称，仅用于脱敏的数量/名称观测。"""
    names: list[str] = []
    for schema in tools or ():
        if not isinstance(schema, dict):
            continue
        name = schema.get("name")
        if not name and isinstance(schema.get("function"), dict):
            name = schema["function"].get("name")
        if isinstance(name, str) and name and name not in names:
            names.append(name)
    return names


def _trace_conversation_messages(messages: Any, system_location: str) -> Any:
    """把 provider 的 system 搬运形式还原成 LoopScope 的统一展示形式。

    OpenAI 兼容接口把 system 放在 messages[0]，但 LoopScope 同时有独立的
    system_prompt 字段。展示时保留一份即可，避免用户误以为 system_prompt
    为空或 system 被重复组装；实际发送给 provider 的 messages 不在这里修改。
    """
    if system_location != "messages[0]" or not isinstance(messages, list) or not messages:
        return _jsonable(messages)
    first = messages[0]
    if isinstance(first, dict) and first.get("role") == "system":
        return _jsonable(messages[1:])
    return _jsonable(messages)


def _skill_result_metadata(value: Any) -> dict[str, Any]:
    """只提取 Skill 注入的脱敏元数据，不把正文复制到诊断 Span。"""
    try:
        payload = json.loads(value) if isinstance(value, str) else value
    except (TypeError, ValueError):
        payload = None
    if not isinstance(payload, dict):
        return {}
    body = payload.get("content")
    if not isinstance(body, str):
        return {"skill": str(payload.get("skill") or "")}
    return {
        "skill": str(payload.get("skill") or ""),
        "content_chars": len(body),
        "content_digest": hashlib.sha256(body.encode("utf-8")).hexdigest()[:16],
        "content_tokens_estimate": _estimate_tokens(body),
    }

def ensure_hooks() -> None:
    global _hooks_installed
    if _hooks_installed or not _enabled():
        return

    try:
        from agent.llm import genstream
        from agent.core import LLMRunner
        from agent.tools import registry
        from agent.context import builder as context_builder
        from agent.context import loaders as context_loaders
    except Exception:
        return

    original_begin = genstream.begin
    original_publish = genstream.publish
    original_run_loop = LLMRunner._run_loop
    original_dispatch = registry.dispatch
    original_builder_build = install_context_hooks(context_loaders, context_builder)

    async def begin(session_id):
        result = await original_begin(session_id)
        try:
            trace_id = get_trace() or uuid.uuid4().hex[:12]
            run = _scope_run.get()
            if run is None or run.ended_at is not None:
                run = _ScopeRun(
                    id=f"run-{trace_id}-{uuid.uuid4().hex[:6]}",
                    trace_id=trace_id,
                    session_key=f"gugu:web:{session_id}",
                    external_session_id=str(session_id),
                    source="web",
                    started_at=_now(),
                )
            else:
                run.trace_id = trace_id
                run.session_key = f"gugu:web:{session_id}"
                run.external_session_id = str(session_id)
                run.source = "web"
            _scope_run.set(run)
        except Exception:
            pass
        return result

    async def publish(session_id, event):
        result = await original_publish(session_id, event)
        try:
            run = _scope_run.get()
            if run is not None and str(session_id) == run.external_session_id and isinstance(event, dict):
                etype = event.get("type")
                if etype == "token":
                    run.output_text += str(event.get("content") or "")
                elif etype == "done":
                    out = run.span(
                        "output", "Final response", {"source": "genstream.publish"},
                        code=_code_ref(original_publish),
                        token_impact={"output_tokens_estimate": _estimate_tokens(run.output_text)},
                    )
                    out.finish({"text": run.output_text})
                    _finish_run(run, "success")
                elif etype == "error":
                    err = run.span("output", "Agent error", {}, code=_code_ref(original_publish))
                    err.finish(event, status="error")
                    _finish_run(run, "error")
        except Exception:
            pass
        return result

    async def dispatch(user_id, name, args):
        run = _scope_run.get()
        tool = getattr(registry, "_tools", {}).get(name)
        handler = getattr(tool, "handler", None)
        span = run.span(
            "tool", str(name), {"arguments": _jsonable(args)},
            code=_code_ref(handler or original_dispatch),
            token_impact={"argument_tokens": _estimate_tokens(args)},
        ) if run else None
        try:
            result = await original_dispatch(user_id, name, args)
            if span:
                tool_result, artifact = result
                span.token_impact["result_tokens"] = _estimate_tokens(tool_result)
                span.finish({"result": _jsonable(tool_result), "artifact": _jsonable(artifact)})
                if name == "use_skill" and run:
                    metadata = _skill_result_metadata(tool_result)
                    if metadata:
                        skill_span = run.span(
                            "context",
                            "Skill context injected",
                            metadata,
                            code=_code_ref(handler or original_dispatch),
                            token_impact={
                                "included_tokens": metadata.get("content_tokens_estimate", 0),
                            },
                            context_source="skill_body",
                            skill=metadata.get("skill", ""),
                            action="loaded",
                        )
                        skill_span.finish({
                            "skill": metadata.get("skill", ""),
                            "content_digest": metadata.get("content_digest", ""),
                        })
            return result
        except BaseException as exc:
            if span:
                span.finish({"error_type": type(exc).__name__}, status="error")
            raise

    async def run_loop(
        self, driver, user_id, messages, ai, system_text, session_id=None,
        session=None, on_interaction=None,
    ):
        run = _scope_run.get()
        if run is not None and session_id is not None:
            # Web 在 genstream.begin 中已经完成归属；IM 没有 genstream
            # begin/publish，而是在 worker 中通过 trace.set_trace() 恢复 pending run。
            # 这里使用当前任务的 IM Context 完成最终归属，避免 QQ/飞书 trace
            # 静默丢失或错误落到 gugu:web:*。
            try:
                from agent.im.imctx import get_im

                im_context = get_im() or {}
            except Exception:
                im_context = {}
            if im_context.get("platform"):
                source = str(im_context["platform"])
                run.source = source
                run.session_key = f"gugu:{source}:{session_id}"
            elif run.source == "unknown" or run.session_key.startswith("pending:"):
                run.source = "web"
                run.session_key = f"gugu:web:{session_id}"
            run.external_session_id = str(session_id)
        original_round = getattr(driver, "run_round")
        round_index = 0
        previous_prompt_estimate = 0
        tool_schema_context_recorded = False
        capability_context_recorded = False

        initial_user = _extract_last_user(messages)
        # 这些值同时用于有/无 LoopScope run 的路径。IM 可能尚未建立 web trace，
        # 但 traced_round 仍然需要完整的展示元数据。
        plain_system = system_text or ""
        effective_system = plain_system or _system_message_text(messages)
        system_location = "system_param" if plain_system else "messages[0]"
        system_assembly = {
            "location": system_location,
            "digest": _prompt_digest(effective_system),
            "tokens_estimate": _estimate_tokens(effective_system),
            "source": "context.system_prompt" if plain_system else "context.messages[0]",
        }
        if run:
            run.input = {
                "user_message": initial_user,
                "user_id": str(user_id),
            }
            from agent.providers import adapter_for
            _adapter = adapter_for(ai)
            run.attributes.update({
                "provider": getattr(ai, "provider", ""),
                "model": getattr(ai, "model", ""),
                "api_format": getattr(driver, "api_format", ""),
                "cache_mode": getattr(_adapter, "cache_mode", "active"),
            })
            model_name = str(getattr(ai, "model", "") or "")
            system_est = _estimate_tokens(plain_system, model_name)
            messages_est = _estimate_tokens(messages, model_name)
            ctx_span = run.span(
                "context",
                "Context assembly & prompt",
                {
                    "system_prompt": plain_system,
                    "messages": _jsonable(messages),
                    "assembly": {
                        "system": system_assembly,
                        "messages": {"count": len(messages) if isinstance(messages, list) else None},
                    },
                },
                code=_code_ref(original_builder_build),
                token_impact={
                    "system_tokens_estimate": system_est,
                    "messages_tokens_estimate": messages_est,
                    "estimated_input_tokens": system_est + messages_est,
                },
                note="Full application-visible prompt/messages at loop entry",
            )
            ctx_span.started_at = run.started_at
            ctx_span.finish({
                # OpenAI 兼容接口把 system 放在 messages[0]；Context span 仍展示
                # provider 实际会消费的完整 system，避免 LoopScope 看见空值。
                "system_prompt": effective_system,
                "message_count": len(messages) if isinstance(messages, list) else None,
            })
            run.attach_context_spans(ctx_span.id)

            history = run.span(
                "history",
                "Conversation messages sent to loop",
                {"messages": _jsonable(messages)},
                parent_span_id=ctx_span.id,
                code=_code_ref(original_run_loop),
                token_impact={"included_tokens": messages_est},
            )
            history.finish({"message_count": len(messages) if isinstance(messages, list) else None})

        async def traced_round(client, ctx, round_messages):
            nonlocal round_index, previous_prompt_estimate, tool_schema_context_recorded, capability_context_recorded
            round_index += 1
            round_visible_messages = _trace_conversation_messages(round_messages, system_location)
            round_system = effective_system
            model_name = str(getattr(ai, "model", "") or "")
            round_prompt_est = (
                _estimate_tokens(round_visible_messages, model_name)
                + _estimate_tokens(round_system, model_name)
            )
            growth = max(round_prompt_est - previous_prompt_estimate, 0) if previous_prompt_estimate else 0
            cache_diag = _cache_diagnostics(round_messages, ctx, model_name)
            from agent.context.canonical_tool_history import canonical_event_stats
            canonical_stats = canonical_event_stats(round_messages)
            if run:
                record_canonical_event_stats(run, canonical_stats)
                record_adapter_call(
                    run,
                    provider=str(getattr(ai, "provider", "") or "unknown"),
                    api_format=str(getattr(driver, "api_format", "") or "unknown"),
                    canonical_event_count=int(canonical_stats.get("count", 0) or 0),
                )
            if run and not tool_schema_context_recorded:
                tool_schema_context_recorded = True
                selected_tool_names = list(
                    getattr(
                        getattr(getattr(ctx, "capability_context", None), "selection", None),
                        "tool_names", (),
                    )
                )
                # 兼容已注入但尚未挂载 capability context 的旧 driver/worker：
                # 观测应反映 provider 实际收到的 Schema 数量，不因选择元数据缺失显示为 0。
                if not selected_tool_names:
                    selected_tool_names = _tool_names_from_schemas(getattr(ctx, "tools", None))
                schema_tokens = int(cache_diag.get("tool_schema_tokens_estimate", 0) or 0)
                schema_bytes = int(cache_diag.get("tool_schema_bytes", 0) or 0)
                tool_context = run.span(
                    "context",
                    "Tool schemas injected",
                    {
                        "tool_count": cache_diag.get("tool_count", 0),
                        "schema_bytes": schema_bytes,
                        "schema_digest": cache_diag.get("tool_schema_digest", ""),
                        "selected_tool_names": selected_tool_names,
                    },
                    parent_span_id=ctx_span.id,
                    code=_code_ref(original_round),
                    token_impact={
                        "included_tokens": schema_tokens,
                        "estimate_source": "loopscope_tokenizer",
                    },
                    context_source="tool_schema",
                    api_format=getattr(driver, "api_format", ""),
                )
                tool_context.finish({
                    "tool_count": cache_diag.get("tool_count", 0),
                    "schema_bytes": schema_bytes,
                    "schema_tokens_estimate": schema_tokens,
                })
            if run and not capability_context_recorded:
                capability_context_recorded = True
                capability_context = getattr(ctx, "capability_context", None)
                if capability_context is not None:
                    from agent.capabilities.diagnostics import capability_injection_diagnostics
                    capability_context_span = run.span(
                        "context",
                        "Capability catalog injected",
                        capability_injection_diagnostics(capability_context),
                        parent_span_id=ctx_span.id,
                        code=_code_ref(original_round),
                        context_source="capability_catalog",
                    )
                    capability_context_span.finish(
                        capability_injection_diagnostics(capability_context)
                    )
            span = run.span(
                "llm",
                f"LLM round {round_index}",
                {
                    "system_prompt": round_system,
                    "messages": round_visible_messages,
                    "assembly": {
                        "system": {
                            **system_assembly,
                            "reused": round_index > 1,
                            "source_round": 1,
                        },
                        "messages": {
                            "count": len(round_messages) if isinstance(round_messages, list) else None,
                            "round": round_index,
                        },
                        "cache": cache_diag,
                        "canonical_events": canonical_stats,
                        "adapter": {
                            "provider": getattr(ai, "provider", ""),
                            "api_format": getattr(driver, "api_format", ""),
                        },
                    },
                },
                code=_code_ref(original_round),
                token_impact={
                    "prompt_tokens_estimate": round_prompt_est,
                    "prompt_growth_estimate": growth,
                    "tool_schema_tokens_estimate": cache_diag.get("tool_schema_tokens_estimate", 0),
                    "cache_anchor_tokens_estimate": cache_diag.get("cache_anchor_tokens_estimate", 0),
                },
                round=round_index,
                provider=getattr(ai, "provider", ""),
                model=getattr(ai, "model", ""),
            ) if run else None
            previous_prompt_estimate = round_prompt_est
            final = None
            try:
                async for kind, value in original_round(client, ctx, round_messages):
                    if kind == "done":
                        final = value
                        # 外层主循环收到 ("done", …) 会立即 break、不再消费本生成器,
                        # 所以 usage 必须在这里（yield 之前）就落地,不能放在循环结束后。
                        if span:
                            details = _round_result(final, getattr(driver, "api_format", ""))
                            span.usage = _jsonable(details.get("usage") or {})
                            # 估算值用于请求开始前的可视化；LLM 返回后补上供应商实际口径，
                            # 避免 LoopScope 把本地估算误看成 provider prompt token。
                            provider_input = span.usage.get("input")
                            if isinstance(provider_input, (int, float)) and provider_input > 0:
                                span.token_impact["prompt_tokens_actual"] = int(provider_input)
                                span.token_impact["prompt_tokens_source"] = "provider"
                            else:
                                span.token_impact["prompt_tokens_source"] = "estimate"
                            span.finish(details)
                            run.add_usage(span.usage)
                            record_adapter_result(run, "success")
                    yield kind, value
            except (GeneratorExit, asyncio.CancelledError):
                # 外层提前 break/取消时生成器在此被关闭——不是本轮失败,不标 error。
                # 注意 Python 3.14 下 async for 在 try 里提前退出会把关闭推迟到
                # GC 才执行,注入的可能是 CancelledError 而非 GeneratorExit,
                # 两者都要当「取消」处理。
                if span and span.status == "running":
                    span.finish({"error_type": "cancelled"}, status="cancelled")
                if run:
                    record_adapter_result(run, "cancelled")
                raise
            except BaseException as exc:
                if span:
                    span.finish({"error_type": type(exc).__name__}, status="error")
                if run:
                    record_adapter_result(run, "error")
                raise

        try:
            driver.run_round = traced_round
            async for line in original_run_loop(
                self, driver, user_id, messages, ai, system_text, session_id=session_id,
                session=session,
                on_interaction=on_interaction,
            ):
                yield line
                if run and isinstance(line, str) and '\"_new_round\"' in line:
                    prompt = _extract_last_user(messages)
                    if prompt and prompt != initial_user:
                        transition = run.span(
                            "guard", _classify_followup(prompt), {"followup_prompt": prompt},
                            code=_code_ref(original_run_loop),
                            token_impact={"followup_tokens": _estimate_tokens(prompt)},
                        )
                    else:
                        transition = run.span(
                            "state", "Continue after tool round", {"round": round_index},
                            code=_code_ref(original_run_loop),
                        )
                    transition.finish({"next_round": round_index + 1})
        finally:
            try:
                driver.run_round = original_round
            except Exception:
                pass

    genstream.begin = begin
    genstream.publish = publish
    registry.dispatch = dispatch
    LLMRunner._run_loop = run_loop
    _hooks_installed = True
