"""Web SSE adapter —— 对话编排（迁自原 agent.py 的 _stream）。

职责：配额检查 → 取上下文（projects/events/memory）→ 会话 get/create + 写
user message + yield session_id → 组装 system prompt → 按 provider 组 messages
→ 调 core.LLMRunner → 收集 full_reply / usage → 持久化 assistant message +
AgentUsage → yield done。对外 SSE 事件流与原实现字节级一致。
"""
import calendar as _cal  # noqa: F401  (保留与原实现一致的导入位置)
import json
import logging

logger = logging.getLogger(__name__)
from datetime import datetime, timedelta
from typing import AsyncGenerator

from sqlalchemy import select, func, and_

from app.core.config import get_settings
from app.models import (
    AgentUsage, CalendarEvent, ConversationMessage, ConversationSession,
    Project, User,
)
from agent import sanitize
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


async def stream(req: AgentRequest) -> AsyncGenerator[str, None]:
    user_id = req.user_id
    profile = DefaultProfile()
    settings = get_settings()

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()

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
                    yield f"data: {json.dumps({'type': 'error', 'message': '咕咕精力不足，休息一下再来吧～'})}\n\n"
                    return

            # 本周（周一 00:00 UTC 起）
            _limit_week = user.token_limit_weekly or settings.quota.default_token_limit_weekly
            if _limit_week is not None:
                _week_start = (_now - timedelta(days=_now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
                _used_week = await _token_used(_week_start)
                if _used_week >= _limit_week:
                    yield f"data: {json.dumps({'type': 'error', 'message': '咕咕本周精力耗尽啦，每周一恢复～'})}\n\n"
                    return

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
            session = ConversationSession(user_id=user_id, title=req.message[:50])
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

        db.add(ConversationMessage(session_id=session.id, role="user", content=req.message))
        await db.commit()
        session_id = session.id

    yield f"data: {json.dumps({'type': 'session_id', 'session_id': session_id})}\n\n"

    # ── system prompt ──
    prompt_name = profile.prompt_file.removesuffix(".md")
    memory = await loaders.load_memory(user_id) if profile.memory_enabled else {}
    system_prompt = builder.build(prompt_name, req.user_name, projects, events, memory, files_overview)

    use_anthropic = (
        settings.ai.provider == "minimax"
        or "anthropic" in settings.ai.base_url.lower()
    )

    runner = LLMRunner(profile.tool_names, settings)
    full_reply = ""
    usage_tokens = {"input": 0, "output": 0}
    anthr_messages: list = []
    anthr_initial_len: int = 0

    try:
        if use_anthropic:
            for h in history:
                if h.content_json is not None:
                    anthr_messages.append({"role": h.role, "content": h.content_json})
                else:
                    anthr_messages.append({"role": h.role, "content": h.content or ""})
            anthr_messages.append({"role": "user", "content": req.message})
            anthr_initial_len = len(anthr_messages)
            gen = runner.run(user_id, system_prompt, anthr_messages, use_anthropic=True)
        else:
            oa_messages = [{"role": "system", "content": system_prompt}]
            for h in history:
                oa_messages.append({"role": h.role, "content": h.content or ""})
            oa_messages.append({"role": "user", "content": req.message})
            gen = runner.run(user_id, None, oa_messages, use_anthropic=False)

        san = sanitize.StreamSanitizer()
        async for evt_str in gen:
            try:
                evt = json.loads(evt_str[6:])
            except Exception:
                yield evt_str
                continue
            etype = evt.get("type")
            if etype == "_new_round":
                san = sanitize.StreamSanitizer()  # 新一轮重置，防止上轮 _cut 污染
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"  # 通知前端，显示等待指示
                continue
            if etype == "_usage":
                usage_tokens["input"]  = evt["input"]
                usage_tokens["output"] = evt["output"]
                continue  # 不转发给客户端
            if etype == "token":
                # 清洗 MiniMax 漏出的 tool-call 标记；标记后内容丢弃
                clean = san.feed(evt["content"])
                if clean:
                    full_reply += clean
                    yield f"data: {json.dumps({'type': 'token', 'content': clean})}\n\n"
                continue
            yield evt_str

        # 冲洗清洗器残留（未触发截断时的尾部）
        tail = san.flush()
        if tail:
            full_reply += tail
            yield f"data: {json.dumps({'type': 'token', 'content': tail})}\n\n"

        # ── 持久化：工具调用中间消息 + AI 最终回复 + 用量 ──
        async with _sess._SessionLocal() as db2:
            # 工具调用轮次（assistant tool_use + user tool_result）逐条落库
            for tm in anthr_messages[anthr_initial_len:]:
                db2.add(ConversationMessage(
                    session_id=session_id,
                    role=tm["role"],
                    content="",
                    content_json=tm["content"],
                ))
            if full_reply:
                db2.add(ConversationMessage(
                    session_id=session_id,
                    role="assistant",
                    content=full_reply,
                ))
            if usage_tokens["input"] or usage_tokens["output"]:
                db2.add(AgentUsage(
                    user_id=user_id,
                    session_id=session_id,
                    tokens_in=usage_tokens["input"],
                    tokens_out=usage_tokens["output"],
                    model=settings.ai.model,
                    provider=settings.ai.provider,
                ))
            await db2.commit()

        # ── 新会话：根据对话内容生成标题并推送给前端 ──
        if is_new_session and full_reply:
            title = await _generate_title(req.message, full_reply, settings, use_anthropic)
            async with _sess._SessionLocal() as db3:
                s = await db3.get(ConversationSession, session_id)
                if s:
                    s.title = title
                    await db3.commit()
            yield f"data: {json.dumps({'type': 'session_title', 'title': title}, ensure_ascii=False)}\n\n"

        # ── 对话后反思：提炼长期记忆（fire-and-forget，不阻塞、失败不影响）──
        if profile.memory_enabled and full_reply:
            from agent.memory import reflection
            reflection.schedule(user_id, req.user_name, req.message, full_reply, settings)

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    except BaseException as e:
        logger.exception("agent stream error for user %s: %s", req.user_id, e)
        yield f"data: {json.dumps({'type': 'error', 'message': f'咕咕出了点问题，请稍后再试'})}\n\n"
