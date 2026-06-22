"""非流式 runner：把 LLMRunner 的流式工具循环收成"完整一段"回复。

bot 平台（飞书/QQ/微信）不流式，要的是攒完整段一次性发。复用 loaders/builder/
core/sanitize 这套大脑，只把 SSE 流"消费成文本"。web SSE 路（adapters/web.py）不动。

注：历史/会话/持久化/反思暂未接（step 3 worker 再加），此处只负责"一句进、完整答出"。
"""
from __future__ import annotations

import json
from typing import AsyncGenerator

from app.core.config import get_settings
from agent import sanitize
from agent.context import builder, loaders
from agent.core import LLMRunner
from agent.models import AgentRequest, AgentResponse
from agent.profiles import DefaultProfile


async def run_collect(req: AgentRequest) -> AgentResponse:
    """构建上下文+system → 跑工具循环 → 攒完整回复，返回 AgentResponse。"""
    user_id = req.user_id
    profile = DefaultProfile()
    settings = get_settings()

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()

    async with _sess._SessionLocal() as db:
        projects = await loaders.load_projects(db, user_id)
        events = await loaders.load_events(db, user_id)
        files_overview = await loaders.load_files_overview(db, user_id)

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

    if use_anthropic:
        messages = [{"role": "user", "content": req.message}]
        gen = runner.run(user_id, system_prompt, messages, use_anthropic=True)
    else:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": req.message},
        ]
        gen = runner.run(user_id, None, messages, use_anthropic=False)

    text, tin, tout = await _collect(gen)
    return AgentResponse(
        text=text, session_id=req.session_id, tokens_in=tin, tokens_out=tout
    )


async def _collect(gen: AsyncGenerator[str, None]) -> tuple[str, int, int]:
    """消费 LLMRunner 的 SSE 流：清洗后攒文本 + 取用量；出错返回错误文案。"""
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
            return (evt.get("message") or "咕咕出了点问题，请稍后再试", tin, tout)
    full += san.flush()
    return (full.strip(), tin, tout)
