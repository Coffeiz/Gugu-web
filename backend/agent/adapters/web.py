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

from sqlalchemy import select, func, and_

from app.core.config import get_settings
from app.core import chat_attach
from app.models import (
    AgentUsage, CalendarEvent, ConversationMessage, ConversationSession,
    Project, User,
)
from agent import sanitize, genstream
from agent.context import builder, loaders, tokens
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
    try:
        if use_anthropic:
            import httpx
            from anthropic import AsyncAnthropic
            client = AsyncAnthropic(
                api_key=settings.ai.api_key or "dummy",
                base_url=settings.ai.base_url,
                http_client=httpx.AsyncClient(timeout=httpx.Timeout(10.0)),
            )
            resp = await client.messages.create(
                model=settings.ai.model,
                max_tokens=30,
                messages=[{"role": "user", "content": prompt}],
            )
            return resp.content[0].text.strip()[:30]
        else:
            import httpx
            from openai import AsyncOpenAI
            client = AsyncOpenAI(
                api_key=settings.ai.api_key or "dummy",
                base_url=settings.ai.base_url,
                timeout=httpx.Timeout(10.0),
            )
            resp = await client.chat.completions.create(
                model=settings.ai.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=30,
            )
            return (resp.choices[0].message.content or "").strip()[:30]
    except Exception:
        return user_msg[:20]


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

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()

    degraded = False   # 配额耗尽 → 不硬拦，降级：只保留只读/轻量工具（查询/对话仍可用，屏蔽重操作）
    async with _sess._SessionLocal() as db:
        # ── token 配额检查 ──
        user = await db.get(User, user_id)
        if user:
            _now = datetime.utcnow()

            async def _token_used(since: datetime) -> int:
                r = await db.execute(
                    select(func.sum(AgentUsage.tokens_in + AgentUsage.tokens_out))
                    .where(and_(AgentUsage.user_id == user_id, AgentUsage.created_at >= since))
                )
                return r.scalar() or 0

            # 固定 6h 窗口：每天 00:00/06:00/12:00/18:00 UTC 整点重置（非滑动）
            _limit_6h = user.token_limit_6h or settings.quota.default_token_limit_6h
            if _limit_6h is not None:
                _win_6h = _now.replace(hour=(_now.hour // 6) * 6, minute=0, second=0, microsecond=0)
                _used_6h = await _token_used(_win_6h)
                if _used_6h >= _limit_6h:
                    degraded = True   # 6h 配额耗尽 → 降级（不 return）

            # 本周（周一 00:00 UTC 起）
            _limit_week = user.token_limit_weekly or settings.quota.default_token_limit_weekly
            if _limit_week is not None:
                _week_start = (_now - timedelta(days=_now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
                _used_week = await _token_used(_week_start)
                if _used_week >= _limit_week:
                    degraded = True   # 周配额耗尽 → 降级（不 return）

        # ── 上下文：项目 + 事件 + 文件概览（每轮注入，保证咕咕看到最新状态）──
        projects = await loaders.load_projects(db, user_id)
        events = await loaders.load_events(db, user_id)
        files_overview = await loaders.load_files_overview(db, user_id)

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

        # 历史窗口：取最新若干条（条数安全上限），再按 token 预算从新往回裁剪
        hist_res = await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == session.id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(tokens.HISTORY_MAX_MSGS)
        )
        history = tokens.select_history(hist_res.scalars().all(), token_budget=settings.ai.context_tokens)

        # 聊天附件：文本读内容注入给模型，图片/二进制给提示；卡片随用户消息持久化
        aug_text, attach_cards, aug_images = await chat_attach.resolve_for_message(user_id, req.attachments, req.message)
        db.add(ConversationMessage(session_id=session.id, role="user", content=req.message,
                                   files=attach_cards or None))
        await db.commit()
        session_id = session.id

    yield f"data: {json.dumps({'type': 'session_id', 'session_id': session_id})}\n\n"

    # ── 启动后台生成（脱离本请求：浏览器刷新/断开杀不掉它，持久化也在任务里）──
    #    再转发该会话的生成频道。客户端断开只停转发，后台任务继续到完成。
    if not await genstream.is_active(session_id):
        task = asyncio.create_task(_generate(
            req, session_id, projects, events, files_overview, history, is_new_session, aug_text, aug_images,
            degraded=degraded,
        ))
        _gen_tasks.add(task)
        task.add_done_callback(_gen_tasks.discard)

    async for line in genstream.subscribe(session_id):
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


async def _generate(req, session_id, projects, events, files_overview, history, is_new_session,
                    user_content=None, user_images=None, degraded=False) -> None:
    """后台生成任务：跑 LLM、把事件发到 genstream 频道、自己持久化。

    脱离 HTTP 请求存活——浏览器刷新/断开不影响它跑完、不丢回复。`stream()` 与
    「续看端点」都只是订阅这条频道。user_content 是注入了附件内容的用户消息（给模型用，
    持久化/反思仍用 req.message 原文）。
    """
    user_id = req.user_id
    user_content = user_content if user_content is not None else req.message
    user_images = user_images or []
    settings = get_settings()
    profile = DefaultProfile()
    import app.db.session as _sess

    await genstream.begin(session_id)

    prompt_name = profile.prompt_file.removesuffix(".md")
    memory = await loaders.load_memory(user_id) if profile.memory_enabled else {}
    system_prompt = builder.build(prompt_name, req.user_name, projects, events, memory, files_overview)

    # 对话摘要：从历史弹出 summary 条，注入 system prompt（不能当 role="summary" 消息发给 LLM）
    from agent.context import compress_conv
    _summary, history = compress_conv.pop_summary(history)
    if _summary:
        system_prompt += compress_conv.system_block(_summary)

    # 配额降级：只给只读/轻量工具 + 提示咕咕婉拒重操作（查询/对话照常）
    tool_names = profile.tool_names
    if degraded:
        tool_names = profile.light_tool_names
        system_prompt += ("\n\n[当前状态：精力配额已用尽，进入轻量模式] 只能做查询和对话。"
                          "涉及创建/修改/删除/整理文件/生成文档/联网搜索等重操作时，"
                          "礼貌告知用户「精力不足，等配额恢复后再帮你做」，不要假装已完成。")

    use_anthropic = (
        settings.ai.provider == "minimax"
        or "anthropic" in settings.ai.base_url.lower()
    )

    runner = LLMRunner(tool_names, settings)
    full_reply = ""
    usage_tokens = {"input": 0, "output": 0}
    anthr_messages: list = []
    anthr_initial_len: int = 0
    sent_files: list = []   # 咕咕本轮发的文件卡片，随助手消息持久化
    used_tools: list = []   # 本次对话调用的工具名（去重保留顺序）

    try:
        if use_anthropic:
            for h in history:
                if h.content_json is not None:
                    anthr_messages.append({"role": h.role, "content": h.content_json})
                else:
                    anthr_messages.append({"role": h.role, "content": h.content or ""})
            anthr_messages.append({"role": "user", "content": chat_attach.build_user_content(user_content, user_images, True)})
            anthr_initial_len = len(anthr_messages)
            gen = runner.run(user_id, system_prompt, anthr_messages, use_anthropic=True)
        else:
            oa_messages = [{"role": "system", "content": system_prompt}]
            for h in history:
                oa_messages.append({"role": h.role, "content": h.content or ""})
            oa_messages.append({"role": "user", "content": chat_attach.build_user_content(user_content, user_images, False)})
            gen = runner.run(user_id, None, oa_messages, use_anthropic=False)

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
            if out:
                full_reply += out
                await genstream.publish(session_id, {"type": "token", "content": out})

        san = sanitize.StreamSanitizer()
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
                san = sanitize.StreamSanitizer()  # 新一轮重置，防止上轮 _cut 污染
                await genstream.publish(session_id, {"type": "_new_round"})
                continue
            if etype == "_usage":
                usage_tokens["input"]  = evt["input"]
                usage_tokens["output"] = evt["output"]
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
        async with _sess._SessionLocal() as db2:
            for tm in anthr_messages[anthr_initial_len:]:
                db2.add(ConversationMessage(
                    session_id=session_id, role=tm["role"], content="",
                    content_json=chat_attach.strip_vision_for_history(tm["content"]),
                ))
            if full_reply or sent_files:
                db2.add(ConversationMessage(
                    session_id=session_id, role="assistant", content=full_reply, files=sent_files or None,
                ))
            if usage_tokens["input"] or usage_tokens["output"]:
                db2.add(AgentUsage(
                    user_id=user_id, session_id=session_id,
                    tokens_in=usage_tokens["input"], tokens_out=usage_tokens["output"],
                    model=settings.ai.model, provider=settings.ai.provider,
                    tools_used=used_tools or None,
                ))
            await db2.commit()

        # ── 新会话：根据对话内容生成标题并推送（空标题不覆盖原首句截断）──
        if is_new_session and full_reply:
            title = (await _generate_title(req.message, full_reply, settings, use_anthropic) or "").strip()
            if title:
                async with _sess._SessionLocal() as db3:
                    s = await db3.get(ConversationSession, session_id)
                    if s:
                        s.title = title
                        await db3.commit()
                await genstream.publish(session_id, {"type": "session_title", "title": title})

        # ── 对话后反思：提炼长期记忆（fire-and-forget）──
        if profile.memory_enabled and full_reply:
            from agent.memory import reflection
            reflection.schedule(user_id, req.user_name, req.message, full_reply, settings)

        # ── 对话压缩：token 超阈值时后台静默压缩旧消息（fire-and-forget）──
        from agent.context import compress_conv
        compress_conv.schedule(session_id, user_id, settings, settings.ai.context_tokens)

        await genstream.publish(session_id, {"type": "done"})

    except BaseException as e:
        logger.exception("agent generate error for user %s: %s", req.user_id, e)
        print(f"[web] agent generate error for {req.user_id}: {type(e).__name__}: {e}", flush=True)
        msg = ("咕咕网络不太好 📡 可以再发一遍吗？" if _is_network_error(e)
               else "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？")
        await genstream.publish(session_id, {"type": "error", "message": msg})
    finally:
        await genstream.end(session_id)
