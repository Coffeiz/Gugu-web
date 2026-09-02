"""Web SSE adapter —— 对话编排（迁自原 agent.py 的 _stream）。

职责：配额检查 → 取上下文（projects/events/memory）→ 会话 get/create + 写
user message + yield session_id → 组装 system prompt → 按 provider 组 messages
→ 调 core.LLMRunner → 收集 full_reply / usage → 持久化 assistant message +
AgentUsage → yield done。对外 SSE 事件流与原实现字节级一致。
"""
import asyncio
import json
import logging

logger = logging.getLogger(__name__)
from typing import AsyncGenerator

from sqlalchemy import select

from app.core.config import get_settings
from app.core import chat_attach
from app.core.tz import set_ctx_tz
from app.models import ConversationMessage, ConversationSession
from agent.security import sanitize
from agent.llm import genstream
from agent import quota
from agent.context import builder, loaders, session_snapshot, session_history, run_context
from agent.core import LLMRunner
from agent.models import AgentRequest
from agent.profiles import DefaultProfile
from agent.llm.llm_select import resolve_run_config, resolve_run_config_for_user


def _canonical_tool_batch_records(messages) -> list[dict]:
    """只把已封存的工具批次交给统一收尾，避免从 provider wire 反推历史。"""
    records = getattr(messages, "canonical_batch_records", ())
    return [record for record in records
            if isinstance(record, dict)
            and (record.get("metadata") or {}).get("round_id")]


def _build_title_prompt(user_msg: str, ai_reply: str) -> str:
    """构造新会话标题提示词，标题语言跟随当前对话语言。"""
    return (
        "根据下面这段对话，用一句话起一个简短的标题（10字以内，不含引号和标点符号）。"
        "标题必须使用与用户和咕咕交流相同的语言；如果对话主要使用英文，就用英文输出；"
        "如果主要使用日文，就用日文输出。不要因为本提示词使用中文而输出中文。"
        "只输出标题本身，不要任何解释。\n"
        f"用户：{user_msg[:150]}\n咕咕：{ai_reply[:300]}"
    )


async def _generate_title(user_msg: str, ai_reply: str, settings, use_anthropic: bool, ai=None) -> str:
    """用 LLM 为新对话起标题（非流式，快速调用）。失败时回退到截断用户消息。"""
    prompt = _build_title_prompt(user_msg, ai_reply)
    from agent import providers
    ai = ai or settings.ai
    provider_adapter = providers.adapter_for(ai)
    try:
        if use_anthropic:
            import httpx
            client = providers.build_anthropic_client(ai, httpx.Timeout(10.0))
            # mimo 默认开思考，30 token 会被思考块吃光、content[0] 是 thinking 块取不到 .text → 标题空。
            # 显式关思考（与正文同口径），并从 content 里挑真正的 text 块，别按下标取。
            extra = provider_adapter.build_anthropic_thinking_params(ai)
            resp = await client.messages.create(
                model=ai.model,
                max_tokens=40,
                messages=[{"role": "user", "content": prompt}],
                **extra,
            )
            text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
            return (text.strip()[:30]) or user_msg[:20]
        else:
            import httpx
            client = providers.build_openai_client(ai, httpx.Timeout(10.0))
            extra = provider_adapter.build_openai_thinking_kwargs(ai)
            resp = await client.chat.completions.create(
                model=ai.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=40,
                **extra,
            )
            return (resp.choices[0].message.content or "").strip()[:30] or user_msg[:20]
    except Exception:
        return user_msg[:20]


async def _generate_summary(convo: str, settings, use_anthropic: bool) -> str:
    """用 LLM 给一段会话起「一句话总结」（这段聊了啥），供跨 session 查找/续接。
    非流式、快速、失败回空（调用方据空不覆盖原总结）。结构同 _generate_title。"""
    prompt = (
        "用一句话（20字以内）概括下面这段对话主要在聊什么 / 在做什么，"
        "供日后检索和接着聊时一眼认出。只输出那句话，不要引号、不要解释。\n\n"
        f"{convo[:1500]}"
    )
    from agent import providers
    provider_adapter = providers.adapter_for(settings.ai)
    try:
        if use_anthropic:
            import httpx
            client = providers.build_anthropic_client(settings.ai, httpx.Timeout(10.0))
            extra = provider_adapter.build_anthropic_thinking_params(settings.ai)
            resp = await client.messages.create(
                model=settings.ai.model, max_tokens=80,
                messages=[{"role": "user", "content": prompt}], **extra)
            text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
            return text.strip().strip('"「」')[:120]
        else:
            import httpx
            client = providers.build_openai_client(settings.ai, httpx.Timeout(10.0))
            extra = provider_adapter.build_openai_thinking_kwargs(settings.ai)
            resp = await client.chat.completions.create(
                model=settings.ai.model, max_tokens=80,
                messages=[{"role": "user", "content": prompt}], **extra)
            return (resp.choices[0].message.content or "").strip().strip('"「」')[:120]
    except Exception:
        return ""


def _is_network_error(e: BaseException) -> bool:
    """LLM 服务商连接/超时类错误（与逻辑性 bug 区分，给"网络不好"文案）。
    用类型+字符串双判，免得为各家 SDK 一一导入异常类。"""
    if isinstance(e, (ConnectionError, TimeoutError)):
        return True
    blob = f"{type(e).__module__}.{type(e).__name__} {e}".lower()
    return any(k in blob for k in ("timeout", "connect", "network", "ssl",
                                   "econnreset", "read operation"))


async def stream(req: AgentRequest) -> AsyncGenerator[str, None]:
    user_id = req.user_id
    profile = DefaultProfile()
    settings = get_settings()
    model_cfg = resolve_run_config(settings, req).model
    from agent.runtime import trace
    trace.new_trace()   # 全链路 trace（web 路入口）：本轮工具轨迹日志自动带同一 id

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()

    async with _sess._SessionLocal() as db:
        run_config = await resolve_run_config_for_user(settings, db, user_id, req)
        model_cfg = run_config.model
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
            memory = await loaders.load_memory(user_id, req.message) if profile.memory_enabled else {}
            im_channels = await loaders.load_im_channels(user_id)
            static_prompt, snapshot_context, _ = builder.build_split(
                profile.prompt_file.removesuffix(".md"), req.user_name,
                projects, events, memory, files_overview,
                notes=notes,
                skills=profile.skills, style_prefs=style_prefs, source="web",
                im_channels=im_channels, user_msg=req.message, user_tz=user_tz,
            )
            return {"system_prompt": static_prompt, "snapshot_context": snapshot_context,
                    "session_info": {"user_name": req.user_name, "source": "web",
                                      "profile": profile.prompt_file},
                    "user_tz": user_tz, "im_channels": im_channels, "im_memory": {},
                    "memory_summary_hash": session_snapshot.memory_summary_hash(memory),
                    "locale": current_locale,
                    }

        async def _load_system_prompt(current_user_tz):
            return builder.build_static_prompt(
                profile.prompt_file.removesuffix(".md"), req.user_name,
                skills=profile.skills, style_prefs=style_prefs,
                current_date=session_snapshot.current_date_text(current_user_tz),
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
        aug_text, attach_cards, aug_images, aug_media = await chat_attach.resolve_for_message(
            user_id, req.attachments, req.message, model_cfg=model_cfg)
        from agent.context.references import build_reference_context
        reference_text = await build_reference_context(db, user_id, req.references)
        if reference_text:
            aug_text = f"{reference_text}\n\n{aug_text}" if aug_text else reference_text
        user_message = ConversationMessage(session_id=session.id, role="user", content=req.message,
                                           files=attach_cards or None,
                                           references_json=req.references or None)
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
        await db.commit()
        session_id = session.id
        # 后台生成任务需要用真实 session id 建立跨 worker gate；新会话在这里才拿到 id。
        req.session_id = session_id

    yield f"data: {json.dumps({'type': 'session_id', 'session_id': session_id})}\n\n"

    # 记忆控制命令（/memory /forget）：确定性短路，零 LLM、不计精力、不反思；先于配额（命令免费）
    from agent import commands as _commands
    command_name, _command_arg = _commands.parse(req.message)
    goal_start, goal_text = _commands.is_goal_start(req.message)
    cmd_reply = await _commands.handle(user_id, req.message, session_id=session_id)
    if command_name in {"goal", "unlimited"}:
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
                from app.services.conversation_retention import trim_session_messages
                await trim_session_messages(session_id)
        async for line in genstream.typed_stream(block_msg):   # 逐字流式：复用 SSE token 动画，咕咕「打字」感
            yield line
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
        return

    # 主模型支持音频时直接保留音频块；否则才用独立「语音识别模型」转文字。
    # 两者都不可用时，resolve_for_message 已在 aug_text 中留下不支持提示。
    _transcribe_media = [m for m in aug_media if m.get("type") != "video"]
    if _transcribe_media and chat_attach.should_transcribe_audio(model_cfg):
        from agent import voice as _voice
        async with _sess._SessionLocal() as voice_db:
            transcript = await _voice.transcribe(
                _transcribe_media, settings, db=voice_db, user_id=user_id,
            )
        if transcript is None:        # 未配置语音模型
            block_msg = "抱歉，我现在还不能处理语音 / 音视频消息哦，打字告诉我就行～"
            async with _sess._SessionLocal() as db2:
                if await db2.get(ConversationSession, session_id) is not None:
                    db2.add(ConversationMessage(session_id=session_id, role="assistant", content=block_msg))
                    await db2.commit()
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
    pubsub = await genstream.open_subscription(session_id)
    active_before_start = await genstream.is_active(session_id)
    if not active_before_start:
        # 先标记 active，再创建脱离请求的后台任务。否则新会话刚收到 session_id
        # 时点击中断会看到 active=false，cancel 请求会错过这次生成。
        await genstream.begin(session_id)
        task = asyncio.create_task(_generate(
            req, session_id, snapshot, history, is_new_session, aug_text, aug_images,
            attach_cards=attach_cards, user_media=aug_media, user_tz=user_tz,
            sent_at=user_message.sent_at, user_message=user_message,
            session=session, history_stats=history_stats, model_cfg=model_cfg,
            locale=current_locale,
            strip_thinking=strip_thinking,
        ))
        _gen_tasks.add(task)
        task.add_done_callback(_gen_tasks.discard)

    async for line in genstream.subscribe(session_id, pubsub=pubsub):
        yield line


_gen_tasks: set = set()   # 持后台生成任务引用，防 GC（任务需脱离请求存活）


async def resume(session_id) -> AsyncGenerator[str, None]:
    """续看：浏览器刷新后重连进行中的生成。先把已生成的内容补一次，再订阅后续。

    没有进行中的生成（或已完成）→ 立即发 idle done，前端就走正常 DB 加载。
    （快照→订阅之间有极小窗口可能漏几个 token，刷新瞬间可接受；回复最终以 DB 为准。）
    """
    snap = await genstream.snapshot(session_id)
    if not snap or snap.get("done"):
        yield f"data: {json.dumps({'type': 'done', 'idle': True})}\n\n"
        return
    if snap.get("text"):
        yield f"data: {json.dumps({'type': 'token', 'content': snap['text']}, ensure_ascii=False)}\n\n"
    for f in (snap.get("files") or []):
        yield f"data: {json.dumps({'type': 'file', 'file': f}, ensure_ascii=False)}\n\n"
    if snap.get("tool"):
        yield f"data: {json.dumps({'type': 'tool_call', 'name': '_preparing', 'label': snap['tool']}, ensure_ascii=False)}\n\n"
    async for line in genstream.subscribe(session_id):
        yield line


async def _generate_unlocked(req, session_id, snapshot, history, is_new_session,
                    user_content=None, user_images=None, attach_cards=None,
                    user_media=None, user_tz=None, sent_at=None,
                    user_message=None, resume_interaction: bool = False,
                    strip_thinking: bool = False, session=None,
                    history_stats=None, model_cfg=None, locale=None) -> None:
    """后台生成任务：跑 LLM、把事件发到 genstream 频道、自己持久化。

    脱离 HTTP 请求存活——浏览器刷新/断开不影响它跑完、不丢回复。`stream()` 与
    「续看端点」都只是订阅这条频道。user_content 是注入了附件内容的用户消息（给模型用，
    持久化/反思仍用 req.message 原文）。
    """
    user_id = req.user_id
    set_ctx_tz(user_tz)   # 本任务内（含 build 与 tool dispatch）「今天」按用户时区算（Phase 3）
    user_content = user_content if user_content is not None else req.message
    user_images = user_images or []
    attach_cards = attach_cards or []
    user_media = user_media or []
    settings = get_settings()
    run_config = resolve_run_config(settings, req) if model_cfg is None else None
    model_cfg = model_cfg or run_config.model
    profile = DefaultProfile()
    import app.db.session as _sess

    system_prompt = snapshot["system_prompt"]
    snapshot_context = snapshot["snapshot_context"]
    stance_text = builder.stance_block(
        await loaders.load_dynamic_memory(user_id) if profile.memory_enabled else {}
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

    # Web 后台生成与 IM 共用稳定能力目录：简介模式首轮注入全部已授权工具的
    # 短描述和字段签名；完整业务 Schema 仍通过 get_tool_schema 按需获取。
    from agent.runner import _capability_context, _filter_shell_tool
    async with _sess._SessionLocal() as db:
        if model_cfg is None:
            run_config = await resolve_run_config_for_user(settings, db, user_id, req)
            model_cfg = run_config.model
        tool_names = await _filter_shell_tool(db, user_id, session_id, list(profile.tool_names))
    capability_context = await _capability_context(
        tool_names, settings, owner_id=user_id, query=getattr(req, "message", ""),
    )
    if capability_context is not None:
        from agent.capabilities.injector import catalog_block
        _snapshot_injection = session_snapshot.snapshot_message(
            f"{snapshot_context}\n\n{catalog_block(capability_context.snapshot, tool_order=capability_context.snapshot.tools)}"
        )

    from agent.llm.llm_select import use_anthropic_for
    use_anthropic = run_config.use_anthropic if run_config is not None else use_anthropic_for(model_cfg)

    runner_locale = locale or snapshot.get("locale") or req.locale or "zh-CN"
    runner = LLMRunner(tool_names, settings, capability_context=capability_context, locale=runner_locale)
    full_reply = ""
    display_timeline: list[dict] = []
    active_segment: dict | None = None
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
    generation_failed = False
    anthr_messages: list = []
    anthr_initial_len: int = 0
    oa_messages: list = []
    oa_initial_len: int = 0
    sent_files: list = []   # 咕咕本轮发的文件卡片，随助手消息持久化
    used_tools: list = []   # 本次对话调用的工具名（去重保留顺序）

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
        )
        anthr_messages = prepared.anthr_messages
        anthr_initial_len = prepared.anthr_initial_len
        oa_messages = prepared.oa_messages
        oa_initial_len = prepared.oa_initial_len
        rag_context = prepared.rag_context
        gen = runner.run(
            user_id,
            system_prompt if use_anthropic else None,
            anthr_messages if use_anthropic else oa_messages,
            use_anthropic=use_anthropic,
            model_cfg=model_cfg,
            session_id=session_id,
            session=session,
        )

        # 跨轮去重（流式版的 _collect 去重）：MiniMax 多轮工具调用常把上一轮文本整段重述，
        # 流式直接追加会重复显示（口语 ~ 叠成 ~~ 还会被 GFM 渲染成删除线）。这里按住本轮开头与
        # 上一轮匹配的前缀，只吐真正新增的部分。
        last_round = ""    # 上一轮模型产出的完整文本
        round_buf  = ""    # 本轮累计（含被跳过的重复前缀），供下一轮比对
        dedup      = False

        async def emit_clean(text: str):
            nonlocal full_reply, round_buf, dedup, active_segment
            if not text:
                return
            if dedup:
                round_buf += text
                if len(round_buf) < len(last_round):
                    if last_round.startswith(round_buf):
                        return                  # 仍是上一轮前缀，继续观望、先不发
                    out = round_buf             # 提前偏离 → 不是重述，整段发
                else:
                    # 达到/超过上一轮长度：完整匹配=重述，跳过重复部分；否则整段发
                    out = round_buf[len(last_round):] if round_buf.startswith(last_round) else round_buf
                dedup = False
            else:
                round_buf += text
                out = text
            out = sanitize.strip_disallowed_emoji(out)   # 出口兜底删白名单外 emoji（prompt 压不住）
            if out:
                full_reply += out
                if active_segment is None:
                    active_segment = {
                        "kind": "assistant",
                        "runId": current_run_id or None,
                        "roundId": current_round_id or None,
                        "text": "",
                    }
                    display_timeline.append(active_segment)
                active_segment["text"] += out
                await genstream.publish(session_id, {"type": "token", "content": out})

        from agent import providers
        provider_adapter = providers.adapter_for(model_cfg)
        san = sanitize.StreamSanitizer(adapter=provider_adapter)
        async for evt_str in gen:
            try:
                evt = json.loads(evt_str[6:])
            except Exception:
                continue
            etype = evt.get("type")
            if etype == "round_start":
                if active_segment and active_segment.get("text"):
                    active_segment = None
                current_run_id = str(evt.get("run_id") or current_run_id)
                current_round_id = str(evt.get("round_id") or current_round_id)
                await genstream.publish(session_id, evt)
                continue
            if etype == "_new_round":
                last_round = round_buf            # 上一轮完整文本
                round_buf  = ""
                dedup      = bool(last_round)     # 有上一轮才需去重
                san = sanitize.StreamSanitizer(adapter=provider_adapter)  # 新一轮重置，防止上轮 _cut 污染
                active_segment = None
                # 保留 round_id/run_id，前端需要用它结束上一轮正文气泡并建立下一轮边界。
                await genstream.publish(session_id, evt)
                continue
            if etype == "_usage":
                usage_tokens["input"]  = evt["input"]
                usage_tokens["context_input"] = max(
                    usage_tokens["context_input"],
                    int(evt.get("context_input", evt["input"]) or 0),
                )
                usage_tokens["output"] = evt["output"]
                usage_tokens["cache_read"] = evt.get("cache_read", 0) or 0
                usage_tokens["cache_write"] = evt.get("cache_write", 0) or 0
                continue  # 不转发给客户端
            if etype == "_context_compaction":
                compaction_applied = bool(evt.get("applied")) or compaction_applied
            if etype == "token":
                # 清洗 MiniMax 漏出的 tool-call 标记；标记后内容丢弃
                clean = san.feed(evt["content"])
                if clean:
                    await emit_clean(clean)
                continue
            if etype == "tool_call":
                name = evt.get("name", "")
                if name and not name.startswith("_") and name not in used_tools:
                    used_tools.append(name)
                if name and not name.startswith("_"):
                    display_timeline.append({
                        "kind": "tool",
                        "toolCallId": str(evt.get("tool_call_id") or ""),
                        "toolName": name,
                        "toolLabel": evt.get("label") or name,
                        "toolInput": evt.get("input"),
                        "toolStatus": evt.get("status") or "running",
                    })
            if etype == "tool_done":
                call_id = str(evt.get("tool_call_id") or "")
                for item in reversed(display_timeline):
                    if item.get("kind") == "tool" and item.get("toolCallId") == call_id:
                        item["toolStatus"] = evt.get("status") or "success"
                        if "result" in evt:
                            item["toolResult"] = evt.get("result")
                        break
            if etype == "file" and evt.get("file"):
                sent_files.append(evt["file"])   # 捕获以便持久化，仍转发给前端
            if etype == "_cancelled":
                cancelled = True
            elif etype == "error":
                generation_failed = True
            await genstream.publish(session_id, evt)

        if cancelled or generation_failed:
            return

        # 冲洗清洗器残留（未触发截断时的尾部）
        tail = san.flush()
        if tail:
            await emit_clean(tail)
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
                rag_context=rag_context,
                messages=anthr_messages if use_anthropic else oa_messages,
                initial_len=anthr_initial_len if use_anthropic else oa_initial_len,
                stance_text=prepared.stance_to_persist,
                user_message_id=getattr(user_message, "id", None),
                canonical_batches=_canonical_tool_batch_records(anthr_messages if use_anthropic else oa_messages),
                text=full_reply,
                display_timeline=[
                    item for item in display_timeline
                    if item.get("kind") == "tool" or item.get("text")
                ],
                files=sent_files,
                tokens_in=usage_tokens["input"],
                tokens_out=usage_tokens["output"],
                cache_read=usage_tokens["cache_read"],
                cache_write=usage_tokens["cache_write"],
                tools_used=used_tools,
                context_tokens=getattr(model_cfg, "context_tokens", settings.ai.context_tokens),
                actual_usage_tokens=int(usage_tokens.get("context_input", 0) or 0),
                compaction_applied=compaction_applied,
                session_exists_required=True,
            )
        except IntegrityError:
            logger.warning("会话 %s 在生成期间被删除，跳过本次持久化", session_id)

        # 回复正文已经持久化后，聊天流就应当结束。标题、总结、反思和压缩都是后台收尾，
        # 不能让前端在文本已经完整显示后继续保持“终止生成”状态；session gate 会在
        # baseline 提交完成后才允许同一会话进入下一轮。
        await genstream.publish(session_id, {"type": "done"})
        run_completed = True

        # ── 新会话：根据对话内容生成标题并推送（空标题不覆盖原首句截断）──
        if is_new_session and full_reply and not resume_interaction:
            title = (await _generate_title(req.message, full_reply, settings, use_anthropic, model_cfg) or "").strip()
            if title:
                async with _sess._SessionLocal() as db3:
                    s = await db3.get(ConversationSession, session_id)
                    if s:
                        s.title = title
                        await db3.commit()
                await genstream.publish(session_id, {"type": "session_title", "title": title})

        # ── 会话「一句话总结」：新会话出一版、之后每 ~6 条刷新（供 search/续接桥；与 IM 路同一套）──
        if full_reply and not resume_interaction:
            from agent.runner import _schedule_summary
            _schedule_summary(req.user_id, session_id, is_new_session, settings, use_anthropic)

        # ── 对话后反思：提炼长期记忆（fire-and-forget）──
        if profile.memory_enabled and full_reply and not resume_interaction:
            from agent.memory import reflection
            reflection.schedule(user_id, req.user_name, req.message, full_reply, settings,
                                used_tools=used_tools, session_id=session_id)

    except BaseException as e:
        generation_failed = True
        logger.exception("agent generate error for user %s: %s", req.user_id, e)
        is_network_error = _is_network_error(e)
        msg = ("咕咕网络不太好 📡 可以再发一遍吗？" if is_network_error
               else "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？")
        await genstream.publish(session_id, {
            "type": "error",
            "message": msg,
            "message_key": "chatUi.networkError" if is_network_error else "chatUi.genericError",
        })
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
        await genstream.end(session_id)


async def _generate(req, session_id, snapshot, history, is_new_session,
                    user_content=None, user_images=None, attach_cards=None,
                    user_media=None, user_tz=None, sent_at=None,
                    user_message=None, resume_interaction: bool = False,
                    strip_thinking: bool = False, session=None,
                    history_stats=None, model_cfg=None, locale=None) -> None:
    """持有 session gate 运行 Web 后台生成，并等待 baseline 提交完成。"""
    from agent.context import compress_conv

    async with compress_conv.session_run_gate(req):
        await _generate_unlocked(
            req, session_id, snapshot, history, is_new_session,
            user_content=user_content, user_images=user_images,
            attach_cards=attach_cards, user_media=user_media,
            user_tz=user_tz, sent_at=sent_at, user_message=user_message,
            resume_interaction=resume_interaction, strip_thinking=strip_thinking,
            session=session, history_stats=history_stats, model_cfg=model_cfg,
            locale=locale,
        )
        await compress_conv.wait_for_baseline_update(session_id)
