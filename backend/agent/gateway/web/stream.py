"""Web Gateway stream 实现。"""
from __future__ import annotations
import asyncio
import json
import logging
from typing import AsyncGenerator
from sqlalchemy import select
from agent.media import gates
from agent.chat.attachments import resolve_for_message
from app.core import chat_attach
from app.core.config import get_settings
from app.core.tz import set_ctx_tz
from app.models import ConversationMessage, ConversationSession
from agent.errors import describe_llm_error
from agent.llm import genstream
from agent import quota
from agent.context import builder, dynamic_tail, loaders, session_snapshot, session_history, run_context, session_system
from agent.models import AgentRequest
from agent.capabilities.defaults import DEFAULT_PROMPT_NAME, SYSTEM_MEMORY_ENABLED, all_system_tool_names
from agent.llm.llm_select import resolve_run_config, resolve_run_config_for_user
from .events import _publish_session_append
from .queued import _stream_queued_run
from .run_lifecycle import _generate, _gen_tasks, _session_gen_tasks
logger = logging.getLogger(__name__)


async def stream(req: AgentRequest) -> AsyncGenerator[str, None]:
    user_id = req.user_id
    settings = get_settings()
    from agent.llm import modelctx
    modelctx.mark_user_scope()
    model_cfg = resolve_run_config(settings, req).model
    from agent.runtime import trace
    trace.new_trace()   # 全链路 trace（web 路入口）：本轮工具轨迹日志自动带同一 id

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()

    async with _sess._SessionLocal() as db:
        run_config = await resolve_run_config_for_user(settings, db, user_id, req)
        model_cfg = run_config.model
        modelctx.set_model_cfg(model_cfg)   # 后台任务（标题/总结/反思/问候）经 create_task 继承此绑定
        from app.byok.service import resolve_and_bind_user_embedding
        await resolve_and_bind_user_embedding(settings, db, user_id)   # 记忆/RAG 向量化走用户 embedding 凭据（PRD-SEC-2）
        # ── 精力耗尽硬拦判定（与 IM/定时任务 runner 同口径，走 quota.is_exhausted 的 CST 6h/周窗口）──
        quota_exceeded = await quota.is_exhausted(db, user_id, settings)

        # ── 会话 get / create ──
        session = None
        if req.session_id:
            res = await db.execute(
                select(ConversationSession).where(
                    ConversationSession.id == req.session_id,
                    ConversationSession.user_id == user_id,
                )
            )
            session = res.scalars().first()

        is_new_session = session is None
        if not session:
            session = ConversationSession(user_id=user_id, title=req.message[:50], source="web")
            db.add(session)
            await db.flush()
            # 前端展示过的默认问候 → 先落为本会话首条 assistant 消息（在用户消息之前），
            # 这样用户对问候的回复不会被当成「对话刚开始」。问候由 /agent/greeting 轻量直连生成、
            # 不计精力；此处仅把已显示文本入库（不写 AgentUsage，照样不计精力）。
            # 先 flush 让它的 created_at 早于稍后写入的用户消息，下面历史查询即可纳入它。
            if req.greeting and req.greeting.strip():
                db.add(ConversationMessage(session_id=session.id, role="assistant",
                                           content=req.greeting.strip()))
                await db.flush()

        style_prefs = await loaders.load_style_prefs(db, user_id)
        current_locale = req.locale or style_prefs.get("locale", "zh-CN")
        if req.locale:
            style_prefs = {**style_prefs, "locale": req.locale}

        async def _load_snapshot():
            user_tz = await loaders.load_user_tz(db, user_id)
            projects = await loaders.load_projects(db, user_id)
            events = await loaders.load_events(db, user_id, tz=user_tz)
            notes = await loaders.load_recent_notes(db, user_id)
            files_overview = await loaders.load_files_overview(db, user_id)
            memory = await loaders.load_memory(
                user_id, req.message, prefer_recent=True,
            ) if SYSTEM_MEMORY_ENABLED else {}
            im_channels = await loaders.load_im_channels(db, user_id)
            knowledge = await loaders.load_knowledge_overview(user_id)
            static_prompt, snapshot_context, _ = builder.build_split(
                DEFAULT_PROMPT_NAME, req.user_name,
                projects, events, memory, files_overview,
                notes=notes,
                style_prefs=style_prefs, source="web",
                im_channels=im_channels, user_msg=req.message, user_tz=user_tz,
                knowledge=knowledge,
            )
            return {"system_prompt": static_prompt, "snapshot_context": snapshot_context,
                    "session_info": {"user_name": req.user_name, "source": "web",
                                      "prompt": f"{DEFAULT_PROMPT_NAME}.md"},
                    "user_tz": user_tz, "im_channels": im_channels, "im_memory": {},
                    "memory_summary_hash": session_snapshot.memory_summary_hash(memory),
                    "locale": current_locale,
                    }

        async def _load_system_prompt(current_user_tz):
            return builder.build_static_prompt(
                DEFAULT_PROMPT_NAME, req.user_name,
                style_prefs=style_prefs,
                current_date=dynamic_tail.current_date_text(current_user_tz),
            )

        snapshot = await session_snapshot.ensure_snapshot(
            db, session, load_context=_load_snapshot, locale=current_locale,
        )
        user_tz = snapshot["user_tz"]
        snapshot["system_prompt"] = await _load_system_prompt(user_tz)
        set_ctx_tz(user_tz)

        # 历史读取不做本地 token 预估；预算由 provider 实际请求结果决定。
        history = await session_history.load_session_history(
            db,
            session.id,
            session_snapshot.history_baseline(session),
        )
        history_stats = session_history.consume_history_stats()
        from agent.context.provider_history import clean_persisted_history, prepare_session
        _, strip_thinking = prepare_session(session, model_cfg)
        if strip_thinking:
            clean_persisted_history(history)
            strip_thinking = False

        # 聊天附件：文本读内容注入给模型，图片/二进制给提示；卡片随用户消息持久化
        aug_text, attach_cards, aug_images, aug_media = await resolve_for_message(
            user_id, req.attachments, req.message, model_cfg=model_cfg, db=db)
        from agent.context.references import build_reference_context, reference_context_block
        reference_text = await build_reference_context(db, user_id, req.references)
        req.reference_context = reference_text or None
        reference_content = (
            [reference_context_block(reference_text), {"type": "text", "text": req.message}]
            if reference_text else None
        )
        # content_json 不能显式传 None：SQLAlchemy JSON 列会把显式 None 序列化成
        # jsonb 'null' 字符串（≠ SQL NULL），导致消息端点按 content_json IS NULL
        # 过滤正文时把这条用户消息整条吞掉（刷新/切会话后气泡消失）。无引用时
        # 省略该字段，走列默认值落成真正的 SQL NULL。
        user_message = ConversationMessage(session_id=session.id, role="user", content=req.message,
                                           files=attach_cards or None,
                                           client_message_id=req.client_message_id,
                                           references_json=req.references or None)
        if reference_content is not None:
            user_message.content_json = reference_content
        db.add(user_message)
        await db.flush()
        # 消息 + 所有附件 claim 是同一个事务（PRD-STORAGE-1 不变量 3）：只 claim
        # resolve_for_message 已经确认存在的 attach_id（cards 里出现的那些），不存在/
        # 输错的 id 在 resolve_for_message 阶段就已经被忽略，不该在这里炸整条消息。
        try:
            await chat_attach.claim_attachments(
                db, user_id, user_message.id, [c["attach_id"] for c in attach_cards])
        except chat_attach.AttachmentClaimError:
            await db.rollback()
            yield f"data: {json.dumps({'type': 'error', 'message': '附件已失效（可能已被使用或清理），请重新发送'})}\n\n"
            return
        from app.services.conversation_pending_queue import PendingQueueClaimConflict, bind_pending_queue
        try:
            await bind_pending_queue(
                db,
                user_id=user_id,
                queue_id=req.pending_queue_id,
                session_id=session.id,
                acknowledged_item_key=req.pending_queue_item_key,
                acknowledged_claim_token=req.pending_queue_claim_token,
                bind_draft_items=is_new_session,
            )
        except PendingQueueClaimConflict:
            await db.rollback()
            yield f"data: {json.dumps({'type': 'error', 'message_key': 'chatUi.pendingQueueDispatchConflict'})}\n\n"
            return
        await db.commit()
        session_id = session.id
        modelctx.set_usage_context(user_id, session_id)
        # 后台生成任务需要用真实 session id 建立跨 worker gate；新会话在这里才拿到 id。
        req.session_id = session_id

    await _publish_session_append(req, session_id, [{
        "role": "user",
        "message_id": user_message.id,
        "client_message_id": req.client_message_id,
        "text": req.message,
        "files": attach_cards or None,
        "references": req.references or None,
    }])
    session_event = {
        "type": "session_id",
        "session_id": session_id,
        "user_message_id": user_message.id,
    }
    if req.client_message_id:
        session_event["client_message_id"] = req.client_message_id
    yield f"data: {json.dumps(session_event)}\n\n"

    # 记忆控制命令（/memory /forget）：确定性短路，零 LLM、不计精力、不反思；先于配额（命令免费）
    from agent import commands as _commands
    command_name, _command_arg = _commands.parse(req.message)
    goal_start, goal_text = _commands.is_goal_start(req.message)
    if command_name == "compact":
        # /compact 在命令处理器里同步等摘要 LLM（可能分块滚动，数十秒），不发
        # 事件前端就只能一直转「。。。」；复用自动压缩的同款状态提示。
        yield f"data: {json.dumps({'type': '_context_compaction', 'phase': 'started', 'reason': 'manual_compact'})}\n\n"
    cmd_reply = await _commands.handle(
        user_id, req.message, session_id=session_id, locale=current_locale,
    )
    if command_name == "compact":
        yield f"data: {json.dumps({'type': '_context_compaction', 'phase': 'completed', 'reason': 'manual_compact'})}\n\n"
    if command_name == "goal":
        async with _sess._SessionLocal() as state_db:
            state_session = await state_db.get(ConversationSession, session_id)
            state_context = state_session.session_context if state_session and isinstance(state_session.session_context, dict) else {}
        goal_active = bool(state_context.get("goal_mode") and state_context.get("goal_text"))
        goal_status = "paused" if state_context.get("goal_status") == "paused" and state_context.get("goal_text") else ("active" if state_context.get("goal_text") else None)
        yield f"data: {json.dumps({'type': 'session_goal', 'session_id': session_id, 'active': goal_active, 'status': goal_status})}\n\n"
    if cmd_reply is not None and not goal_start:
        if isinstance(cmd_reply, dict) and cmd_reply.get("_command_interaction"):
            prompt = cmd_reply.get("prompt") or {}
            yield f"data: {json.dumps({'type': 'interaction_required', **prompt}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return
        async with _sess._SessionLocal() as db2:
            if await db2.get(ConversationSession, session_id) is not None:
                db2.add(ConversationMessage(session_id=session_id, role="assistant", content=cmd_reply))
                await db2.commit()
                await _publish_session_append(req, session_id, [{"role": "assistant", "text": cmd_reply}])
                from app.services.conversation_retention import trim_session_messages
                await trim_session_messages(session_id)
        async for line in genstream.immediate_stream(cmd_reply):
            yield line
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
        return
    if goal_start:
        # /goal 创建状态后继续走正常 runner；原始命令已经作为 user message 持久化，
        # 这里仅替换给模型看的本轮内容，避免模型把斜杠命令误当作普通闲聊。
        aug_text = f"请立即开始执行目标任务：{goal_text}"

    # 精力耗尽 → 硬拦：持久化一句提示并回给前端，不启动生成（查询/对话一律不放行）
    if quota_exceeded:
        block_msg = "咕咕累了，休息会儿再来～"
        async with _sess._SessionLocal() as db2:
            if await db2.get(ConversationSession, session_id) is not None:
                db2.add(ConversationMessage(session_id=session_id, role="assistant", content=block_msg))
                await db2.commit()
                await _publish_session_append(req, session_id, [{"role": "assistant", "text": block_msg}])
                from app.services.conversation_retention import trim_session_messages
                await trim_session_messages(session_id)
        async for line in genstream.typed_stream(block_msg):   # 逐字流式：复用 SSE token 动画，咕咕「打字」感
            yield line
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
        return

    # 主模型支持音频时直接保留音频块；否则才用独立「语音识别模型」转文字。
    # 两者都不可用时，resolve_for_message 已在 aug_text 中留下不支持提示。
    _transcribe_media = [m for m in aug_media if m.get("type") != "video"]
    _audio_fallback = gates.should_transcribe_audio(model_cfg)
    _persist_transcript = any(
        m.get("voice_recognition_enabled") and m.get("kind") == "voice"
        for m in _transcribe_media
    )
    if _transcribe_media and (_audio_fallback or _persist_transcript):
        from agent import voice as _voice
        try:
            async with _sess._SessionLocal() as voice_db:
                transcript = await _voice.transcribe(
                    _transcribe_media, settings, db=voice_db, user_id=user_id,
                    raise_minimax_errors=True,
                )
        except Exception as error:
            if _audio_fallback:
                from agent.providers.minimax import minimax_error_details
                if minimax_error_details(error) is None:
                    raise
                from agent.errors import describe_llm_error
                error_event = describe_llm_error(
                    error, diagnostic_context="agent.gateway.web.voice"
                ).as_event()
                yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                return
            # 主模型可直接听音频时，附加转写失败只标记状态，不中断对话。
            from app.core.redaction import diag_log
            diag_log("agent.gateway.web.voice_transcript", error)
            transcript = None
            transcript_status = "failed"
        else:
            transcript_status = "completed" if transcript and transcript.strip() else "empty"

        if _persist_transcript:
            try:
                from app.services.conversation_transcripts import (
                    publish_voice_transcript_update, save_voice_transcript,
                )
                async with _sess._SessionLocal() as transcript_db:
                    saved_files = await save_voice_transcript(
                        transcript_db, user_id=user_id, session_id=session_id,
                        message_id=user_message.id, transcript=transcript,
                        status=transcript_status,
                    )
                if saved_files is not None:
                    await publish_voice_transcript_update(
                        user_id, session_id=session_id,
                        message_id=user_message.id, files=saved_files,
                    )
            except Exception as error:
                from app.core.redaction import diag_log
                diag_log("agent.gateway.web.persist_voice_transcript", error)

        if _audio_fallback:
            if transcript is None:        # 未配置语音模型
                block_msg = "抱歉，我现在还不能处理语音 / 音视频消息哦，打字告诉我就行～"
                async with _sess._SessionLocal() as db2:
                    if await db2.get(ConversationSession, session_id) is not None:
                        db2.add(ConversationMessage(session_id=session_id, role="assistant", content=block_msg))
                        await db2.commit()
                        await _publish_session_append(req, session_id, [{"role": "assistant", "text": block_msg}])
                        from app.services.conversation_retention import trim_session_messages
                        await trim_session_messages(session_id)
                async for line in genstream.typed_stream(block_msg):
                    yield line
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                return
            spoken = transcript.strip() or "（用户发来一段语音，但这次没听清内容）"
            aug_text = (aug_text + "\n" if aug_text else "") + f"（用户发来语音，内容是：）{spoken}"
            aug_media = [m for m in aug_media if m.get("type") == "video"]

    # ── 先订阅频道、再启动后台生成 ──
    #    顺序很关键：pub/sub 发完即弃，若先起生成、后订阅，生成的头几个 token（短回复时是全部）
    #    会在订阅建好之前被 publish 掉 → 首条消息空气泡。先 attach 订阅，消息就进连接缓冲不丢。
    #    （生成脱离本请求：浏览器刷新/断开只停转发，后台任务继续到完成、自己持久化。）
    # worker 在后台任务 finally 之前退出时，数据库可能仍保留 running，但
    # Redis 的生成快照已经消失。新请求先回收这个明确可判定的孤儿状态，
    # 否则后续消息会一直排在一个实际上不存在的 run 后面。
    from agent.context import compress_conv
    await compress_conv.recover_orphaned_session(session_id, user_id=user_id)
    pubsub = await genstream.open_subscription(session_id)
    active_before_start = await genstream.is_active(session_id)
    owner_run_id = genstream.new_run_id()

    def _register_generation_task(task: asyncio.Task) -> None:
        _gen_tasks.add(task)
        task.add_done_callback(_gen_tasks.discard)

        def _unregister_session_task(done_task, *, _sid: int = session_id, _rid: str = owner_run_id):
            # 同会话「取消后立刻重发」时，旧任务迟到的回调不能把新登记的任务摘掉；
            # 按 owner_run_id 精确摘除，排队任务与当前 run 互不误伤。
            registry = _session_gen_tasks.get(_sid)
            if registry is not None and registry.get(_rid) is done_task:
                registry.pop(_rid, None)
                if not registry:
                    _session_gen_tasks.pop(_sid, None)

        registry = _session_gen_tasks.setdefault(session_id, {})
        registry[owner_run_id] = task
        task.add_done_callback(_unregister_session_task)

    if not active_before_start:
        # 先标记 active，再创建脱离请求的后台任务。否则新会话刚收到 session_id
        # 时点击中断会看到 active=false，cancel 请求会错过这次生成。
        await genstream.begin(session_id, owner_run_id=owner_run_id)
        from app.core import events
        await events.publish_agent_run_changed(
            user_id, session_id=session_id, status="running",
        )
        if req.pending_queue_item_key is not None or (is_new_session and req.pending_queue_id):
            from app.services.conversation_pending_queue import publish_session_pending_queue_changed
            await publish_session_pending_queue_changed(
                req.user_id, session_id, origin=getattr(req, "origin", None),
            )
        task = asyncio.create_task(_generate(
            req, session_id, snapshot, history, is_new_session, aug_text, aug_images,
            attach_cards=attach_cards, user_media=aug_media, user_tz=user_tz,
            sent_at=user_message.sent_at, user_message=user_message,
            session=session, history_stats=history_stats, model_cfg=model_cfg,
            run_config=run_config,
            locale=current_locale,
            strip_thinking=strip_thinking,
            owner_run_id=owner_run_id,
        ))
        _register_generation_task(task)

        async for line in genstream.subscribe(session_id, pubsub=pubsub):
            yield line
        return

    # ── run 进行中到达的消息：真正排队，不再只落库不调度 ──
    # 消息已经在上面落库；这里创建同样的后台任务，让它进 session_run_gate 阻塞
    # 等待当前 run 结束后接续处理。begin 必须推迟到门内执行（begin_after_gate）：
    # 现在就 begin 会清掉当前 run 的快照和归属，破坏正在进行的生成与续看。
    task = asyncio.create_task(_generate(
        req, session_id, snapshot, history, is_new_session, aug_text, aug_images,
        attach_cards=attach_cards, user_media=aug_media, user_tz=user_tz,
        sent_at=user_message.sent_at, user_message=user_message,
        session=session, history_stats=history_stats, model_cfg=model_cfg,
        run_config=run_config,
        locale=current_locale,
        strip_thinking=strip_thinking,
        owner_run_id=owner_run_id,
        begin_after_gate=True,
    ))
    _register_generation_task(task)
    if req.pending_queue_item_key is not None or (is_new_session and req.pending_queue_id):
        from app.services.conversation_pending_queue import publish_session_pending_queue_changed
        await publish_session_pending_queue_changed(
            req.user_id, session_id, origin=getattr(req, "origin", None),
        )
    # 开头「先订阅后启动」建立的订阅直接交给 _stream_queued_run 继续用：pub/sub
    # 发完即弃，排队期间订阅必须一直挂着——run-B begin 后、轮询确认归属前 publish
    # 的事件全在连接缓冲里，不存在「接管之后才订阅」的丢失窗口；转不转发由
    # run_id 归属过滤决定。
    async for line in _stream_queued_run(session_id, owner_run_id, task, pubsub):
        yield line
