"""Web Gateway generation 实现。"""
from __future__ import annotations
import asyncio
import logging
import time
from app.core.config import get_settings
from app.core.tz import set_ctx_tz
from app.models import ConversationMessage, ConversationSession
from agent.errors import describe_llm_error
from agent.llm import genstream
from agent.context import builder, dynamic_tail, loaders, session_snapshot, session_history, run_context, session_system
from agent.conversation.session_metadata import generate_title, schedule_summary
from agent.core import LLMRunner
from agent.capabilities.defaults import DEFAULT_PROMPT_NAME, SYSTEM_MEMORY_ENABLED, all_system_tool_names
from agent.llm.llm_select import resolve_run_config, resolve_run_config_for_user
from .events import _publish_session_append
logger = logging.getLogger(__name__)


async def _close_running_tool_events(display_timeline: list, pub, tool_started_at=None) -> None:
    """给仍在 running/waiting 的工具事件补「已停止」终态。

    工具执行中被取消时 CancelledError 直接打断派发，tool_done 永远不会发出；
    不补终态的话，live 视图的工具气泡永远转圈，落库后刷新也恢复成「进行中」
    （2026-09-19 实测）。对每个未完成条目：修正 display_timeline 状态 + 向
    SSE 补发合成 tool_done，让实时与刷新两端都收敛。
    """
    for item in display_timeline:
        if item.get("kind") != "tool" or item.get("toolStatus") not in ("queued", "running", "waiting", "stopped"):
            continue
        call_id = str(item.get("toolCallId") or "")
        started_at = tool_started_at.pop(call_id, None) if tool_started_at and call_id else None
        duration_ms = max(0, round((time.monotonic() - started_at) * 1000)) if started_at is not None else None
        if duration_ms is not None:
            item["toolDurationMs"] = duration_ms
        item["toolStatus"] = "cancelled"
        event = {
            "type": "tool_done",
            "tool_call_id": item.get("toolCallId"),
            "name": item.get("toolName"),
            "label": item.get("toolLabel"),
            "status": "cancelled",
        }
        if duration_ms is not None:
            event["duration_ms"] = duration_ms
        await pub(event)


async def _generate_unlocked(req, session_id, snapshot, history, is_new_session,
                    user_content=None, user_images=None, attach_cards=None,
                    user_media=None, user_tz=None, sent_at=None,
                    user_message=None, resume_interaction: bool = False,
                    strip_thinking: bool = False, session=None,
                    history_stats=None, model_cfg=None, run_config=None, locale=None,
                    owner_run_id=None) -> None:
    """后台生成任务：跑 LLM、把事件发到 genstream 频道、自己持久化。

    脱离 HTTP 请求存活——浏览器刷新/断开不影响它跑完、不丢回复。`stream()` 与
    「续看端点」都只是订阅这条频道。user_content 是注入了附件内容的用户消息（给模型用，
    持久化/反思仍用 req.message 原文）。
    """
    user_id = req.user_id
    set_ctx_tz(user_tz)   # 本任务内（含 build 与 tool dispatch）「今天」按用户时区算（Phase 3）
    # 取消（task.cancel()）可能落在函数体任意 await 处——CancelledError 收尾要读
    # display_timeline 做部分产物落库，所以这里先初始化，下方正式生成段再重置一次。
    from agent.run.execution import RunOutcome
    outcome = RunOutcome()
    display_timeline = outcome.display_timeline_items
    sent_files = outcome.files
    user_content = user_content if user_content is not None else req.message
    user_images = user_images or []
    attach_cards = attach_cards or []
    user_media = user_media or []
    settings = get_settings()

    owner_run_id = str(owner_run_id or genstream.new_run_id())
    from app.services.conversation_run_outcomes import RunOutcomeTarget, persist_run_outcome
    outcome_target = RunOutcomeTarget(
        user_id=req.user_id,
        session_id=session_id,
        user_message_id=getattr(user_message, "id", None),
        run_id=owner_run_id,
    )

    async def _pub(event: dict) -> None:
        # 本 run 的每个事件统一注入 owner_run_id：provider 内层的 run_id 是核心循环
        # 自造的（core.py 另起 uuid），与 web 侧 owner_run_id 不同；排队连接靠
        # run_id 识别「自己的 run 已开始」并转发（见 _stream_queued_run），token/done
        # 这类原本不带 run_id 的事件必须能归属到 run。
        await genstream.publish(session_id, {
            **event,
            "run_id": owner_run_id,
            # present_file 是发起网页标签页的展示副作用；续看同一会话的其他标签页
            # 也会收到该 SSE，因此显式携带发起端身份供前端定向处理。
            "origin_client_id": getattr(req, "origin", None),
            # run_id 是 Web Gateway 的 owner 身份，供排队 SSE 做归属过滤；展示
            # 时间线持久化的是核心循环 run_id。两者分开传递，避免前端无法把
            # 实时气泡与同一 round 的持久记录关联起来。
            "core_run_id": event.get("run_id") or current_run_id or None,
            "user_message_id": getattr(user_message, "id", None),
        })

    from agent.llm import modelctx
    modelctx.mark_user_scope()
    if run_config is None and model_cfg is None:
        run_config = resolve_run_config(settings, req)
    model_cfg = model_cfg or run_config.model
    import app.db.session as _sess

    system_prompt = snapshot["system_prompt"]
    snapshot_context = snapshot["snapshot_context"]
    stance_text = builder.stance_block(
        await loaders.load_dynamic_memory(user_id) if SYSTEM_MEMORY_ENABLED else {}
    )

    # snapshot 内容在 snapshot 有效期内保持稳定，放在 history 之前形成可缓存前缀。
    _snapshot_injection = (
        session_snapshot.snapshot_message(snapshot_context)
        if snapshot_context else None
    )

    from agent.im.context_loader import format_history_content

    # 默认问候已经在新会话创建时作为 assistant 历史消息落库，并会随 history
    # 发送给模型。不要再把同一段文字追加进 system-reminder：两份语义相同的
    # 开场上下文会提高模型复述问候的概率，也会破坏固定前缀的稳定性。

    # Web 后台生成与 IM 共用能力目录：简介/catalog 模式注入工具短描述和字段签名；
    # full-schema 模式只补用户 Skill，工具 Schema 保持 Provider 的原始完整注入。
    from agent.run.preparation import (
        load_mcp_tools_and_rag_context,
        _pin_session_user_skill_metadata, _session_user_skill_metadata,
        prepare_run_capabilities,
    )
    user_skill_metadata = _session_user_skill_metadata(session)
    async with _sess._SessionLocal() as db:
        if model_cfg is None:
            run_config = await resolve_run_config_for_user(settings, db, user_id, req)
            model_cfg = run_config.model
            modelctx.set_model_cfg(model_cfg)   # 后台任务经 create_task 继承此绑定
            from app.byok.service import resolve_and_bind_user_embedding
            await resolve_and_bind_user_embedding(settings, db, user_id)   # 记忆/RAG 向量化走用户 embedding 凭据（PRD-SEC-2）
        mcp_tools, precomputed_rag_context = await load_mcp_tools_and_rag_context(
            user_id, settings, req.allowed_tool_names, req,
            history=history, snapshot_context=snapshot_context,
            user_message=user_message, resume_interaction=resume_interaction,
        )
        modelctx.set_usage_context(
            user_id, session_id, scenario="mcp" if mcp_tools else "chat",
        )
        tool_names, system_prompt, snapshot_context, capability_context = await prepare_run_capabilities(
            db, user_id, session_id, all_system_tool_names(), settings, system_prompt, snapshot_context,
            session=session, query=req.message,
            user_skill_metadata=user_skill_metadata, dynamic_tools=mcp_tools, source=req.source,
            model_cfg=model_cfg,
        )
        from agent.media.capability_prompt import media_capability_for_user
        media_capability_context = await media_capability_for_user(model_cfg, user_id, db=db)
    system_prompt = "\n\n---\n\n".join((system_prompt, media_capability_context))
    if capability_context is not None:
        if _pin_session_user_skill_metadata(session, capability_context):
            # stream() 已经提交并关闭了原事务；后台生成使用独立事务，首次建立的
            # 用户 Skill 目录必须显式回写，后续请求才能复用同一个会话 snapshot。
            async with _sess._SessionLocal() as snapshot_db:
                stored_session = await snapshot_db.get(ConversationSession, session_id)
                if stored_session is not None:
                    stored_session.session_context = dict(session.session_context or {})
                    await snapshot_db.commit()
        _snapshot_injection = session_snapshot.snapshot_message(snapshot_context)

    from agent.llm.llm_select import use_anthropic_for
    use_anthropic = run_config.use_anthropic if run_config is not None else use_anthropic_for(model_cfg)

    runner_locale = locale or snapshot.get("locale") or req.locale or "zh-CN"
    runner = LLMRunner(
        tool_names, settings, capability_context=capability_context, locale=runner_locale,
        dynamic_tools=mcp_tools,
    )
    full_reply = ""
    canonical_reply = ""
    display_timeline = outcome.display_timeline_items
    tool_started_at: dict[str, float] = {}
    current_run_id = ""
    current_round_id = ""
    # ``input`` 是整个 run 多轮累计用量，供计费使用；``context_input`` 是
    # provider 返回的单次请求上下文峰值，只有它能参与 baseline/压缩判断。
    usage_tokens = {
        "input": 0,
        "context_input": 0,
        "output": 0,
        "cache_read": 0,
        "cache_write": 0,
    }
    compaction_applied = False
    run_completed = False
    cancelled = False
    remote_status_unknown = False
    generation_failed = False
    failure_event = None
    rag_context: dict | None = None
    stance_to_persist: str | None = None
    message_area = None
    sent_files = outcome.files   # 咕咕本轮发的文件卡片，随助手消息持久化
    used_tools: list = []   # 本次对话调用的工具名（去重保留顺序）

    def sync_run_outcome() -> None:
        usage_tokens.update({
            "input": outcome.tokens_in,
            "context_input": outcome.context_input,
            "output": outcome.tokens_out,
            "cache_read": outcome.cache_read,
            "cache_write": outcome.cache_write,
        })
        used_tools[:] = [name for name in outcome.tool_names if name and not name.startswith("_")]
        nonlocal compaction_applied, canonical_reply
        compaction_applied = outcome.compaction_applied
        canonical_reply = outcome.text or next((item.get("text", "") for item in reversed(display_timeline) if item.get("text")), "")

    async def persist_interrupted_run() -> None:
        """保存中止前已完成的历史；不把当前未提交工具批次写成完整往返。"""
        sync_run_outcome()
        delta = message_area.persistence_delta(outcome="interruption") if message_area else None
        if not (display_timeline or full_reply or sent_files or (delta and delta.entries)):
            return
        from agent.context.run_finalize import finalize_run

        await finalize_run(
            session_factory=_sess._SessionLocal,
            session_id=session_id,
            user_id=user_id,
            settings=settings,
            model_cfg=model_cfg,
            message_area=message_area,
            text=canonical_reply,
            display_timeline=display_timeline,
            files=sent_files,
            tokens_in=usage_tokens["input"],
            tokens_out=usage_tokens["output"],
            cache_read=usage_tokens["cache_read"],
            cache_write=usage_tokens["cache_write"],
            tools_used=used_tools,
            compaction_applied=compaction_applied,
            user_message_id=getattr(user_message, "id", None),
            run_id=current_run_id,
            interrupted=True,
            session_exists_required=True,
        )
        await _publish_session_append(req, session_id, [{
            "role": "assistant",
            "text": full_reply,
            "files": sent_files or None,
        }])

    try:
        image_only = bool(user_images) and not user_media and bool(attach_cards) and all(
            str(card.get("kind") or "").lower() == "image" for card in attach_cards
        )
        # 图片首轮仍单独发送视觉块，但文字部分复用历史消息格式；首轮结束后图片
        # 会在 core 中折叠，这样下一次 run 重建出的历史与本轮尾部保持字节一致。
        current_text = (
            format_history_content(user_message, req)
            if image_only and user_message is not None
            else user_content
        )
        prepared = await run_context.prepare_run(
            system_prompt=system_prompt,
            snapshot_context=snapshot_context,
            history=history,
            req=req,
            user_tz=user_tz,
            strip_thinking=strip_thinking,
            use_anthropic=use_anthropic,
            current_text=current_text,
            images=user_images,
            media=user_media,
            model_cfg=model_cfg,
            stance_text=stance_text,
            snapshot_injection=_snapshot_injection,
            user_message=user_message,
            resume_interaction=resume_interaction,
            session=session,
            snapshot=snapshot,
            history_stats=history_stats,
            prepared_rag_context=precomputed_rag_context,
        )
        rag_context = prepared.rag_context
        stance_to_persist = prepared.stance_to_persist
        message_area = prepared.message_area
        gen = runner.run(
            user_id,
            # Responses 通过 instructions 接收稳定 system prompt；所有协议共用同一 Area。
            system_prompt,
            message_area,
            use_anthropic=use_anthropic,
            model_cfg=model_cfg,
            session_id=session_id,
            session=session,
            reasoning_policy=getattr(run_config, "reasoning_persistence", "off"),
            state_session_factory=_sess._SessionLocal,
        )

        async def handle_agent_event(value: dict) -> None:
            nonlocal current_run_id, current_round_id, cancelled, generation_failed, failure_event, remote_status_unknown
            evt = dict(value)
            etype = evt.get("type")
            if etype == "round_start":
                current_run_id = str(evt.get("run_id") or current_run_id)
                current_round_id = str(evt.get("round_id") or current_round_id)
            elif etype == "tool_call":
                call_id = str(evt.get("tool_call_id") or "")
                if call_id and evt.get("status") != "queued":
                    tool_started_at.setdefault(call_id, time.monotonic())
            elif etype == "tool_done":
                tool_started_at.pop(str(evt.get("tool_call_id") or ""), None)
            if etype in {"tool_call", "tool_done"}:
                for item in reversed(display_timeline):
                    if item.get("kind") == "tool" and item.get("toolCallId") == str(evt.get("tool_call_id") or ""):
                        if current_run_id:
                            item.setdefault("runId", current_run_id)
                        if current_round_id:
                            item.setdefault("roundId", current_round_id)
                        break
            if etype == "interaction_required":
                evt = {"session_id": session_id, **evt}
            if etype == "_cancelled":
                cancelled = True
                remote_status_unknown = bool(evt.get("remote_status_unknown"))
            elif etype == "error":
                generation_failed = True
                failure_event = evt
                return
            await _pub(evt)

        async def display_changed(item: dict) -> None:
            nonlocal full_reply
            full_reply = "\n\n".join(entry.get("text", "") for entry in display_timeline if entry.get("kind") == "assistant" and entry.get("text"))
            await _pub({"type": "display_event", "item": item})

        from agent.context.display_checkpoint import save_checkpoint

        async def checkpoint(items):
            await save_checkpoint(_sess._SessionLocal, session_id, items, user_message.id)

        from agent.run.execution import WebStreamSink, consume_agent_events
        async for kind, value in consume_agent_events(
            gen,
            model_cfg=model_cfg,
            outcome=outcome,
            sink=WebStreamSink(
                on_event=handle_agent_event,
                on_display=display_changed,
                on_checkpoint=checkpoint,
                user_message_id=user_message.id,
                yield_round_ends=False,
                yield_tokens=False,
            ),
        ):
            pass

        sync_run_outcome()

        if cancelled or generation_failed:
            # _cancelled 是内部事件，订阅转发只认 done/error 终态；取消收尾不补发
            # done 的话，这条 SSE 会挂到 20s keepalive 兜底才结束，前端一直显示
            # 「输出中」，生成期间排队的消息也发不出去。error 事件本身就会让订阅
            # 者退出，无需重复补发。
            # 被打断的工具先补「已停止」终态：必须在 done 之前发（订阅端收到
            # done 即退出）；失败路径 error 事件后订阅端同样已退出，这里只需
            # 修正 timeline 供落库，合成事件的 pub 是无害冗余。
            await _close_running_tool_events(display_timeline, _pub, tool_started_at)
            # 取消与生成错误采用不同的历史语义：用户主动取消时保留已完成轮次和
            # 部分正文；模型/Provider 报错时不提交本轮增量或部分输出，与 Run
            # finalization 的错误终态保持一致。当前用户消息在生成前已单独落库，
            # 这里跳过的是失败 run 的增量，不删除用户原始消息。
            if cancelled:
                try:
                    await persist_interrupted_run()
                except Exception:
                    logger.exception("取消路径的部分历史持久化失败 session=%s", session_id)
                await _pub({"type": "done", "cancelled": True,
                            "remote_status_unknown": remote_status_unknown})
            elif failure_event:
                from agent.context.display_checkpoint import seal_checkpoint
                await seal_checkpoint(_sess._SessionLocal, session_id, user_message.id)
                await _pub(failure_event)
            return

        # ── 持久化：工具调用中间消息 + AI 最终回复 + 用量 ──
        # 会话可能在后台生成期间被用户删掉；统一收尾契约会跳过孤儿消息并保留 usage 记账。
        from sqlalchemy.exc import IntegrityError
        try:
            from agent.context.run_finalize import finalize_run
            await finalize_run(
                session_factory=_sess._SessionLocal,
                session_id=session_id,
                user_id=user_id,
                settings=settings,
                model_cfg=model_cfg,
                message_area=message_area,
                user_message_id=getattr(user_message, "id", None),
                text=canonical_reply,
                display_timeline=[
                    item for item in display_timeline
                    if (
                        item.get("kind") == "tool"
                        or item.get("text")
                        or item.get("files")
                        or item.get("linkButtons")
                    )
                ],
                files=sent_files,
                tokens_in=usage_tokens["input"],
                tokens_out=usage_tokens["output"],
                cache_read=usage_tokens["cache_read"],
                cache_write=usage_tokens["cache_write"],
                tools_used=used_tools,
                compaction_applied=compaction_applied,
                session_exists_required=True,
                run_id=current_run_id,
                round_id=current_round_id,
            )
            await _publish_session_append(req, session_id, [{
                "role": "assistant",
                "text": full_reply,
                "files": sent_files or None,
            }])
        except IntegrityError:
            logger.warning("会话 %s 在生成期间被删除，跳过本次持久化", session_id)

        # 回复正文已经持久化后，聊天流就应当结束。标题、总结和反思仍是后台收尾；
        # 上下文压缩已经在 provider round 达到 90% 时完成。
        await _pub({"type": "done"})
        run_completed = True

        # ── 新会话：根据对话内容生成标题并推送（空标题不覆盖原首句截断）──
        if is_new_session and full_reply and not resume_interaction:
            title = (await generate_title(
                req.message, full_reply, settings, use_anthropic, model_cfg, locale=locale,
            ) or "").strip()
            if title:
                async with _sess._SessionLocal() as db3:
                    s = await db3.get(ConversationSession, session_id)
                    if s:
                        s.title = title
                        await db3.commit()
                await _pub({"type": "session_title", "title": title})

        # ── 会话「一句话总结」：新会话出一版、之后每 ~6 条刷新（供 search/续接桥；与 IM 路同一套）──
        if full_reply and not resume_interaction:
            schedule_summary(req.user_id, session_id, is_new_session, settings, use_anthropic)

        # ── 对话后反思：提炼长期记忆（fire-and-forget）──
        if SYSTEM_MEMORY_ENABLED and full_reply and not resume_interaction:
            from agent.memory import reflection
            reflection.schedule(user_id, req.user_name, req.message, full_reply, settings,
                                used_tools=used_tools, session_id=session_id)

    except asyncio.CancelledError:
        # 终止端点直收（task.cancel()）和心跳发现取消标记后的硬取消，取消点会落在
        # 本函数体内任意 await 处；必须与业务异常分开收尾——被下面的
        # except BaseException 吞掉的话，用户点「停止」会收到「咕咕开小差了」通用
        # 报错，且本轮持久化整体跳过。发取消终态让订阅端正常退出后 re-raise，
        # 交给外层 _generate 的取消分支清 active 快照。
        # 与 in-band cancelled 分支同款：保留已生成文本与已提交的 canonical
        # 工具轮次；当前未完成的批次不在可提交 Area delta 中，不会留下孤儿调用。
        # 被打断的工具先补「已停止」终态（live 合成 tool_done + timeline 修正），
        # 否则工具气泡在实时与刷新两端都永远停在「进行中」。
        try:
            await _close_running_tool_events(display_timeline, _pub, tool_started_at)
            await persist_interrupted_run()
        except Exception:
            logger.exception("task.cancel 路径的部分展示产物持久化失败 session=%s", session_id)
        from app.services.conversation_run_outcomes import build_run_outcome
        outcome = build_run_outcome(status="interrupted", run_id=owner_run_id)
        await persist_run_outcome(_sess._SessionLocal, outcome_target, outcome)
        from agent.runtime.cancellation import current_remote_status_unknown
        await _pub({"type": "done", "cancelled": True, "run_outcome": outcome,
                    "remote_status_unknown": current_remote_status_unknown()})
        raise
    except BaseException as e:
        generation_failed = True
        from agent.context.display_checkpoint import seal_checkpoint
        if user_message is not None:
            await seal_checkpoint(_sess._SessionLocal, session_id, user_message.id)
        logger.exception("agent generate error for user %s: %s", req.user_id, e)
        presentation = describe_llm_error(e)
        from app.services.conversation_run_outcomes import build_run_outcome
        outcome = build_run_outcome(
            status="failed",
            run_id=owner_run_id,
            error_code=presentation.code,
            message_key=presentation.message_key,
            message_params=presentation.message_params,
        )
        await persist_run_outcome(_sess._SessionLocal, outcome_target, outcome)
        await _pub({**presentation.as_event(), "run_outcome": outcome})
    finally:
        # LoopScope 正常由 genstream 的 done/error 事件收尾；事件发布前异常、
        # Redis 发布失败或后台任务被提前终止时，仍需提交一个终态，避免该 run
        # 在 LoopScope 中完全消失。已结束的 run 由 finish_run 幂等忽略。
        if not run_completed:
            try:
                from agent.runtime import trace as _trace
                _trace.finish_run("error", full_reply if generation_failed else "")
            except Exception as trace_exc:
                from app.core.redaction import diag_log
                diag_log("agent.loopscope.web_finalize", trace_exc)
        from agent.llm.llm_select import release as _release_model
        _release_model(model_cfg)
        await genstream.end(session_id, owner_run_id=owner_run_id)
        try:
            from app.core import events
            await events.publish_agent_run_changed(
                req.user_id,
                session_id=session_id,
                status="failed" if generation_failed or cancelled else "completed",
            )
        except Exception:
            pass
        from app.services.conversation_pending_queue import publish_session_pending_queue_changed
        await publish_session_pending_queue_changed(
            req.user_id, session_id, origin=getattr(req, "origin", None),
        )


async def _refresh_generation_history(session_id: int, snapshot: dict, model_cfg):
    """在 Web generation gate 内重新读取会话水位和历史。

    Web 请求会先写入消息并创建后台任务；如果在后台任务取得 gate 前另一轮完成了
    baseline，任务创建时传入的 session/history 就已经过期。这里必须用新事务重新
    读取，否则下一轮仍会从旧 baseline=0 组装完整历史并再次触发压缩。
    """
    import app.db.session as _sess
    from agent.context.provider_history import clean_persisted_history, prepare_session

    async with _sess._SessionLocal() as db:
        session = await db.get(ConversationSession, session_id)
        if session is None:
            return None
        baseline = session_snapshot.history_baseline(session)
        history = await session_history.load_session_history(db, session_id, baseline)
        history_stats = session_history.consume_history_stats()
        _, should_strip_thinking = prepare_session(session, model_cfg)
        if should_strip_thinking:
            clean_persisted_history(history)
        refreshed_snapshot = dict(snapshot)
        refreshed_snapshot["history_baseline_message_id"] = baseline
        return session, refreshed_snapshot, history, history_stats, bool(should_strip_thinking)
