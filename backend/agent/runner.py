"""非流式 runner：把 LLMRunner 的流式工具循环收成"完整一段"回复。

bot 平台（飞书/QQ/微信）不流式，要的是攒完整段一次性发。复用 loaders/builder/
core/sanitize 这套大脑，把 SSE 流"消费成文本"。会话历史/持久化/反思与 web 同口径：
按 session_id 找/建会话、读历史窗口、存用户+回复消息、对话后反思。session_id 由
worker 按平台用户从 Redis 取（续聊不断），见 worker._im_session_*。
"""
from __future__ import annotations

import json
from typing import AsyncGenerator

from sqlalchemy import select

from app.core.config import get_settings
from agent import sanitize
from agent.context import builder, loaders, tokens
from agent.core import LLMRunner
from agent.models import AgentRequest, AgentResponse
from agent.profiles import DefaultProfile


async def run_collect(req: AgentRequest) -> AgentResponse:
    """找/建会话 + 读历史 → 跑工具循环 → 攒完整回复 + 存盘 + 反思。"""
    user_id = req.user_id
    profile = DefaultProfile()
    settings = get_settings()

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import (
        AgentUsage, ConversationMessage, ConversationSession,
    )

    async with _sess._SessionLocal() as db:
        projects = await loaders.load_projects(db, user_id)
        events = await loaders.load_events(db, user_id)
        files_overview = await loaders.load_files_overview(db, user_id)

        # ── 会话 get / create（IM 续聊靠 worker 传稳定 session_id）──
        session = None
        if req.session_id:
            session = (await db.execute(
                select(ConversationSession).where(
                    ConversationSession.id == req.session_id,
                    ConversationSession.user_id == user_id,
                )
            )).scalars().first()
        if not session:
            session = ConversationSession(user_id=user_id, title=(req.message[:50] or "新对话"), source=getattr(req, "source", "web"))
            db.add(session)
            await db.flush()
        session_id = session.id

        # 历史窗口：最新若干条 → 按 token 预算从新往回裁剪
        hist_res = await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == session_id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(tokens.HISTORY_MAX_MSGS)
        )
        history = tokens.select_history(hist_res.scalars().all(), token_budget=settings.ai.context_tokens)

        db.add(ConversationMessage(session_id=session_id, role="user", content=req.message))
        await db.commit()

    memory = await loaders.load_memory(user_id) if profile.memory_enabled else {}
    prompt_name = profile.prompt_file.removesuffix(".md")
    system_prompt = builder.build(
        prompt_name, req.user_name, projects, events, memory, files_overview
    )

    use_anthropic = (
        settings.ai.provider == "minimax"
        or "anthropic" in settings.ai.base_url.lower()
    )
    runner = LLMRunner(profile.tool_names, settings)

    anthr_messages: list = []
    anthr_initial_len = 0
    if use_anthropic:
        for h in history:
            content = h.content_json if h.content_json is not None else (h.content or "")
            anthr_messages.append({"role": h.role, "content": content})
        anthr_messages.append({"role": "user", "content": req.message})
        anthr_initial_len = len(anthr_messages)
        gen = runner.run(user_id, system_prompt, anthr_messages, use_anthropic=True)
    else:
        oa_messages = [{"role": "system", "content": system_prompt}]
        for h in history:
            oa_messages.append({"role": h.role, "content": h.content or ""})
        oa_messages.append({"role": "user", "content": req.message})
        gen = runner.run(user_id, None, oa_messages, use_anthropic=False)

    text, tin, tout, errored = await _collect(gen)

    # ── 持久化：工具调用轮次（anthropic）+ 回复 + 用量（报错不入历史）──
    if not errored:
        async with _sess._SessionLocal() as db2:
            if use_anthropic:
                for tm in anthr_messages[anthr_initial_len:]:
                    db2.add(ConversationMessage(
                        session_id=session_id, role=tm["role"],
                        content="", content_json=tm["content"],
                    ))
            if text:
                db2.add(ConversationMessage(session_id=session_id, role="assistant", content=text))
            if tin or tout:
                db2.add(AgentUsage(
                    user_id=user_id, session_id=session_id,
                    tokens_in=tin, tokens_out=tout,
                    model=settings.ai.model, provider=settings.ai.provider,
                ))
            await db2.commit()

        # 对话后反思（fire-and-forget）
        if profile.memory_enabled and text:
            from agent.memory import reflection
            reflection.schedule(user_id, req.user_name, req.message, text, settings)

    return AgentResponse(text=text, session_id=session_id, tokens_in=tin, tokens_out=tout)


async def _collect(gen: AsyncGenerator[str, None]) -> tuple[str, int, int, bool]:
    """消费 LLMRunner 的 SSE 流：清洗后攒文本 + 取用量。
    返回 (文本, in, out, errored)；errored=True 时文本是错误文案（不入历史/不反思）。"""
    san = sanitize.StreamSanitizer()
    full = ""
    tin = tout = 0
    async for evt_str in gen:
        try:
            evt = json.loads(evt_str[6:])
        except Exception:
            continue
        t = evt.get("type")
        if t == "_new_round":
            san = sanitize.StreamSanitizer()  # 新一轮重置清洗器
        elif t == "_usage":
            tin = evt.get("input", 0)
            tout = evt.get("output", 0)
        elif t == "token":
            full += san.feed(evt.get("content", ""))
        elif t == "error":
            return (evt.get("message") or "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？", tin, tout, True)
    full += san.flush()
    return (full.strip(), tin, tout, False)
