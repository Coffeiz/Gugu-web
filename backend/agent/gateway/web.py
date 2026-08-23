"""Web SSE adapter —— 对话编排（迁自原 agent.py 的 _stream）。

职责：配额检查 → 取上下文（projects/events/memory）→ 会话 get/create + 写
user message + yield session_id → 组装 system prompt → 按 provider 组 messages
→ 调 core.LLMRunner → 收集 full_reply / usage → 持久化 assistant message +
AgentUsage → yield done。对外 SSE 事件流与原实现字节级一致。
"""
import asyncio
import calendar as _cal  # noqa: F401  (保留与原实现一致的导入位置)
import json
import logging

logger = logging.getLogger(__name__)
from datetime import datetime, timedelta
from typing import AsyncGenerator

from sqlalchemy import select

from app.core.config import get_settings
from app.core import chat_attach
from app.core.tz import set_ctx_tz
from app.models import (
    AgentUsage, CalendarEvent, ConversationMessage, ConversationSession,
    Project, User,
)
from agent.security import sanitize
from agent.llm import genstream
from agent import quota
from agent.context import builder, loaders, tokens, session_snapshot, message_assembly
from agent.core import LLMRunner
from agent.models import AgentRequest
from agent.profiles import DefaultProfile


async def _generate_title(user_msg: str, ai_reply: str, settings, use_anthropic: bool) -> str:
    """用 LLM 为新对话起标题（非流式，快速调用）。失败时回退到截断用户消息。"""
    prompt = (
        "根据下面这段对话，用一句话起一个简短的标题（10字以内，不含引号和标点符号）。"
        "只输出标题本身，不要任何解释。\n"
        f"用户：{user_msg[:150]}\n咕咕：{ai_reply[:300]}"
    )
    from agent import providers
    provider_adapter = providers.adapter_for(settings.ai)
    try:
        if use_anthropic:
            import httpx
            client = providers.build_anthropic_client(settings.ai, httpx.Timeout(10.0))
            # mimo 默认开思考，30 token 会被思考块吃光、content[0] 是 thinking 块取不到 .text → 标题空。
            # 显式关思考（与正文同口径），并从 content 里挑真正的 text 块，别按下标取。
            extra = provider_adapter.build_anthropic_thinking_params(settings.ai)
            resp = await client.messages.create(
                model=settings.ai.model,
                max_tokens=40,
                messages=[{"role": "user", "content": prompt}],
                **extra,
            )
            text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
            return (text.strip()[:30]) or user_msg[:20]
        else:
            import httpx
            client = providers.build_openai_client(settings.ai, httpx.Timeout(10.0))
            extra = provider_adapter.build_openai_thinking_kwargs(settings.ai)
            resp = await client.chat.completions.create(
                model=settings.ai.model,
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
    from agent.runtime import trace
    trace.new_trace()   # 全链路 trace（web 路入口）：本轮工具轨迹日志自动带同一 id

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()

    async with _sess._SessionLocal() as db:
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

        async def _load_snapshot():
            user_tz = await loaders.load_user_tz(db, user_id)
            projects = await loaders.load_projects(db, user_id)
            events = await loaders.load_events(db, user_id, tz=user_tz)
            notes = await loaders.load_recent_notes(db, user_id)
            files_overview = await loaders.load_files_overview(db, user_id)
            style_prefs = await loaders.load_style_prefs(db, user_id)
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
                    }

        snapshot = await session_snapshot.ensure_snapshot(db, session, load_context=_load_snapshot)
        user_tz = snapshot["user_tz"]
        set_ctx_tz(user_tz)

        # 连续历史：不再按最近 N 条滑动；压缩后从 session baseline 之后继续追加。
        from agent.context import session_history
        history = await session_history.load_session_history(
            db, session.id, int(getattr(session, "baseline_message_id", 0) or 0),
        )

        # 聊天附件：文本读内容注入给模型，图片/二进制给提示；卡片随用户消息持久化
        aug_text, attach_cards, aug_images, aug_media = await chat_attach.resolve_for_message(
            user_id, req.attachments, req.message, model_cfg=settings.ai)
        user_message = ConversationMessage(session_id=session.id, role="user", content=req.message,
                                           files=attach_cards or None)
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

    yield f"data: {json.dumps({'type': 'session_id', 'session_id': session_id})}\n\n"

    # 记忆控制命令（/memory /forget）：确定性短路，零 LLM、不计精力、不反思；先于配额（命令免费）
    from agent import commands as _commands
    cmd_reply = await _commands.handle(user_id, req.message, session_id=session_id)
    if cmd_reply is not None:
        async with _sess._SessionLocal() as db2:
            if await db2.get(ConversationSession, session_id) is not None:
                db2.add(ConversationMessage(session_id=session_id, role="assistant", content=cmd_reply))
                await db2.commit()
        async for line in genstream.typed_stream(cmd_reply):
            yield line
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
        return

    # 精力耗尽 → 硬拦：持久化一句提示并回给前端，不启动生成（查询/对话一律不放行）
    if quota_exceeded:
        block_msg = "咕咕累了，休息会儿再来～"
        async with _sess._SessionLocal() as db2:
            if await db2.get(ConversationSession, session_id) is not None:
                db2.add(ConversationMessage(session_id=session_id, role="assistant", content=block_msg))
                await db2.commit()
        async for line in genstream.typed_stream(block_msg):   # 逐字流式：复用 SSE token 动画，咕咕「打字」感
            yield line
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
        return

    # 语音 / 音视频：用独立「语音识别模型」转文字 → 交主模型（不强切）；没配 → 切断回「不支持」。
    _transcribe_media = [m for m in aug_media if m.get("type") != "video"]
    if _transcribe_media:
        from agent import voice as _voice
        transcript = await _voice.transcribe(_transcribe_media, settings)
        if transcript is None:        # 未配置语音模型
            block_msg = "抱歉，我现在还不能处理语音 / 音视频消息哦，打字告诉我就行～"
            async with _sess._SessionLocal() as db2:
                if await db2.get(ConversationSession, session_id) is not None:
                    db2.add(ConversationMessage(session_id=session_id, role="assistant", content=block_msg))
                    await db2.commit()
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
        task = asyncio.create_task(_generate(
            req, session_id, snapshot, history, is_new_session, aug_text, aug_images,
            attach_cards=attach_cards, user_media=aug_media, user_tz=user_tz,
            sent_at=user_message.sent_at, user_message=user_message,
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


async def _generate(req, session_id, snapshot, history, is_new_session,
                    user_content=None, user_images=None, attach_cards=None,
                    user_media=None, user_tz=None, sent_at=None,
                    user_message=None, resume_interaction: bool = False) -> None:
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
    profile = DefaultProfile()
    import app.db.session as _sess

    await genstream.begin(session_id)

    system_prompt = snapshot["system_prompt"]
    snapshot_context = snapshot["snapshot_context"]
    now_str = session_snapshot.current_time_text(user_tz)
    dynamic_tail = builder.dynamic_tail(
        await loaders.load_dynamic_memory(user_id) if profile.memory_enabled else {}
    )

    # snapshot 内容在 snapshot 有效期内保持稳定，放在 history 之前形成可缓存前缀。
    _snapshot_injection = (
        session_snapshot.reminder_message(snapshot_context)
        if snapshot_context else None
    )

    # 对话摘要：从历史弹出 summary 条，注入 system prompt（不能当 role="summary" 消息发给 LLM）
    from agent.context import compress_conv
    from agent.im.context_loader import format_history_content
    from agent.context.history import build_history_parts
    _summary, history = compress_conv.pop_summary(history)

    # 默认问候已经在新会话创建时作为 assistant 历史消息落库，并会随 history
    # 发送给模型。不要再把同一段文字追加进 system-reminder：两份语义相同的
    # 开场上下文会提高模型复述问候的概率，也会破坏固定前缀的稳定性。

    # Web 后台生成与 IM 共用能力目录：首轮只声明能力目录和 ask_user，
    # 只有模型声明后才把对应工具 schema 放回后续轮次。
    from agent.runner import _capability_context, _filter_shell_tool
    async with _sess._SessionLocal() as db:
        tool_names = await _filter_shell_tool(db, user_id, session_id, list(profile.tool_names))
    capability_context = _capability_context(tool_names, settings)
    if capability_context is not None:
        from agent.capabilities.injector import catalog_block
        _snapshot_injection = session_snapshot.reminder_message(
            f"{snapshot_context}\n\n{catalog_block(capability_context.snapshot, kind='tool')}"
        )

    from agent.llm.llm_select import use_anthropic_for
    use_anthropic = use_anthropic_for(settings.ai)

    runner = LLMRunner(tool_names, settings, capability_context=capability_context)
    full_reply = ""
    usage_tokens = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    anthr_messages: list = []
    anthr_initial_len: int = 0
    oa_messages: list = []
    oa_initial_len: int = 0
    sent_files: list = []   # 咕咕本轮发的文件卡片，随助手消息持久化
    used_tools: list = []   # 本次对话调用的工具名（去重保留顺序）

    try:
        fixed_parts = compress_conv.fixed_context_parts(_snapshot_injection, _summary)
        history_parts = build_history_parts(
            history, req, use_anthropic=use_anthropic, user_tz=user_tz)
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
        tail_parts = []
        message_time = (
            session_snapshot.message_time_reminder(user_message.sent_at, user_tz)
            if user_message is not None else None
        )
        if message_time:
            tail_parts.append(message_time)
        tail_parts.extend(message_assembly.reminder(part) for part in dynamic_tail)
        if use_anthropic:
            assembly = message_assembly.build_messages(
                fixed_parts=fixed_parts, history=history_parts,
                current_user=None if resume_interaction else {"role": "user", "content": chat_attach.build_user_content(current_text, user_images, True, media=user_media, image_detail=getattr(settings.ai, "vision_detail", "auto"))},
                dynamic_tail=tail_parts)
            assembly.replace_conversation(sanitize.sanitize_messages(assembly.conversation))
            anthr_messages = assembly
            anthr_initial_len = len(assembly.conversation)
            gen = runner.run(
                user_id, system_prompt, anthr_messages,
                use_anthropic=True, session_id=session_id,
            )
        else:
            oa_messages = message_assembly.build_messages(
                fixed_parts=[{"role": "system", "content": system_prompt}] + fixed_parts,
                history=history_parts,
                current_user=None if resume_interaction else {"role": "user", "content": chat_attach.build_user_content(current_text, user_images, False, media=user_media, image_detail=getattr(settings.ai, "vision_detail", "auto"))},
                dynamic_tail=tail_parts)
            oa_initial_len = len(oa_messages.conversation) if hasattr(oa_messages, "conversation") else len(oa_messages)
            gen = runner.run(
                user_id, None, oa_messages,
                use_anthropic=False, session_id=session_id,
            )

        # 跨轮去重（流式版的 _collect 去重）：MiniMax 多轮工具调用常把上一轮文本整段重述，
        # 流式直接追加会重复显示（口语 ~ 叠成 ~~ 还会被 GFM 渲染成删除线）。这里按住本轮开头与
        # 上一轮匹配的前缀，只吐真正新增的部分。
        last_round = ""    # 上一轮模型产出的完整文本
        round_buf  = ""    # 本轮累计（含被跳过的重复前缀），供下一轮比对
        dedup      = False

        async def emit_clean(text: str):
            nonlocal full_reply, round_buf, dedup
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
                await genstream.publish(session_id, {"type": "token", "content": out})

        from agent import providers
        provider_adapter = providers.adapter_for(settings.ai)
        san = sanitize.StreamSanitizer(adapter=provider_adapter)
        async for evt_str in gen:
            try:
                evt = json.loads(evt_str[6:])
            except Exception:
                continue
            etype = evt.get("type")
            if etype == "_new_round":
                last_round = round_buf            # 上一轮完整文本
                round_buf  = ""
                dedup      = bool(last_round)     # 有上一轮才需去重
                san = sanitize.StreamSanitizer(adapter=provider_adapter)  # 新一轮重置，防止上轮 _cut 污染
                await genstream.publish(session_id, {"type": "_new_round"})
                continue
            if etype == "_usage":
                usage_tokens["input"]  = evt["input"]
                usage_tokens["output"] = evt["output"]
                usage_tokens["cache_read"] = evt.get("cache_read", 0) or 0
                usage_tokens["cache_write"] = evt.get("cache_write", 0) or 0
                continue  # 不转发给客户端
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
            if etype == "file" and evt.get("file"):
                sent_files.append(evt["file"])   # 捕获以便持久化，仍转发给前端
            await genstream.publish(session_id, evt)

        # 冲洗清洗器残留（未触发截断时的尾部）
        tail = san.flush()
        if tail:
            await emit_clean(tail)
        # ── 持久化：工具调用中间消息 + AI 最终回复 + 用量 ──
        # 会话可能在后台生成期间被用户删掉（DELETE /sessions/{id}，合法操作）。此时：
        # 不写无依附的 message；usage 降级为 session_id=None 保住计费（与删除时 SET NULL 一致）；
        # 极端竞态（预检查后、commit 前被删）走 IntegrityError 静默跳过——回复已生成成功，
        # 绝不能因记账失败把整个任务推进 except 给用户误报「开小差」。
        from sqlalchemy.exc import IntegrityError
        try:
            async with _sess._SessionLocal() as db2:
                sess_alive = await db2.get(ConversationSession, session_id) is not None
                if sess_alive:
                    # 两种 provider 都落同一套 canonical tool turn；守卫注入的合成 prompt /
                    # 核实内心戏是控制信令，不进历史。
                    tool_history = message_assembly.newly_appended(
                        anthr_messages if use_anthropic else oa_messages,
                        anthr_initial_len if use_anthropic else oa_initial_len,
                    )
                    from agent.context.history import canonicalize_tool_messages
                    for tm in canonicalize_tool_messages(tool_history):
                        db2.add(ConversationMessage(
                            session_id=session_id, role=tm["role"], content="",
                            content_json=chat_attach.strip_vision_for_history(tm["content"]),
                        ))
                    if full_reply or sent_files:
                        db2.add(ConversationMessage(
                            session_id=session_id, role="assistant", content=full_reply, files=sent_files or None,
                        ))
                snapshot_session = await db2.get(ConversationSession, session_id)
                if snapshot_session is not None:
                    await db2.flush()
                    if not resume_interaction:
                        session_snapshot.checkpoint_snapshot(
                            snapshot_session,
                            [{"role": "user", "content": req.message},
                             {"role": "assistant", "content": full_reply}],
                        )
                # 按 6h 剩余额度封顶本轮用量：精力条最多 100%，单轮顶过线则只记填满部分、
                # 超出（对话后半段）不计入（6h 与周都不计）；已满则 (0,0) 不写。
                _cap_in, _cap_out = await quota.cap_usage(db2, user_id, settings,
                                                          usage_tokens["input"], usage_tokens["output"])
                if _cap_in or _cap_out:
                    db2.add(AgentUsage(
                        user_id=user_id, session_id=session_id if sess_alive else None,
                        tokens_in=_cap_in, tokens_out=_cap_out,
                        cache_read=usage_tokens["cache_read"], cache_write=usage_tokens["cache_write"],
                        model=settings.ai.model, provider=settings.ai.provider,
                        tools_used=used_tools or None,
                    ))
                await db2.commit()
        except IntegrityError:
            logger.warning("会话 %s 在生成期间被删除，跳过本次持久化", session_id)

        # 回复正文已经持久化后，聊天流就应当结束。标题、总结、反思和压缩都是后台收尾，
        # 不能让前端在文本已经完整显示后继续保持“终止生成”状态，也不能阻塞下一条消息。
        await genstream.publish(session_id, {"type": "done"})

        # ── 新会话：根据对话内容生成标题并推送（空标题不覆盖原首句截断）──
        if is_new_session and full_reply and not resume_interaction:
            title = (await _generate_title(req.message, full_reply, settings, use_anthropic) or "").strip()
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
        logger.exception("agent generate error for user %s: %s", req.user_id, e)
        msg = ("咕咕网络不太好 📡 可以再发一遍吗？" if _is_network_error(e)
               else "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？")
        await genstream.publish(session_id, {"type": "error", "message": msg})
    finally:
        await genstream.end(session_id)
