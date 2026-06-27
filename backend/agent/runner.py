"""非流式 runner：把 LLMRunner 的流式工具循环收成"完整一段"回复。

bot 平台（飞书/QQ/微信）不流式，要的是攒完整段一次性发。复用 loaders/builder/
core/sanitize 这套大脑，把 SSE 流"消费成文本"。会话历史/持久化/反思与 web 同口径：
按 session_id 找/建会话、读历史窗口、存用户+回复消息、对话后反思。session_id 由
worker 按平台用户从 Redis 取（续聊不断），见 worker._im_session_*。
"""
from __future__ import annotations

import asyncio
import json
from typing import AsyncGenerator

from sqlalchemy import func, select

from app.core.config import get_settings
from agent import sanitize, quota
from agent.context import builder, loaders, tokens
from agent.core import LLMRunner
from agent.llm_select import pick_model, release as _release_model
from agent.models import AgentRequest, AgentResponse
from agent.profiles import DefaultProfile

# 后台任务引用，防止被 GC（fire-and-forget 的标题生成等）
_bg_tasks: set = set()


def _schedule_title(user_id, session_id, user_msg: str, reply_text: str, settings, use_anthropic: bool) -> None:
    """后台生成新会话标题——移出关键路径，别让用户多等一次 LLM 调用（闲置后尤其明显）。"""
    task = asyncio.create_task(_gen_title_bg(user_id, session_id, user_msg, reply_text, settings, use_anthropic))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


async def _gen_title_bg(user_id, session_id, user_msg: str, reply_text: str, settings, use_anthropic: bool) -> None:
    try:
        from agent.adapters.web import _generate_title
        new_title = await _generate_title(user_msg, reply_text, settings, use_anthropic)
        if not new_title:
            return
        import app.db.session as _sess
        from app.models import ConversationSession
        async with _sess._SessionLocal() as db:
            s = await db.get(ConversationSession, session_id)
            if s:
                s.title = new_title
                await db.commit()
        from app.core import events
        await events.publish(user_id, "sessions", session_id=session_id, title=new_title)  # 标题好了再推一次
    except Exception:
        pass


async def run_collect(req: AgentRequest) -> AgentResponse:
    """找/建会话 + 读历史 → 跑工具循环 → 攒完整回复 + 存盘 + 反思。"""
    user_id = req.user_id
    profile = DefaultProfile()
    settings = get_settings()
    model_cfg = pick_model(settings, req)   # 解析层：active/pool/router 选一个模型配置

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
        style_prefs = await loaders.load_style_prefs(db, user_id)

        # ── 会话 get / create（IM 续聊靠 worker 传稳定 session_id）──
        session = None
        if req.session_id:
            session = (await db.execute(
                select(ConversationSession).where(
                    ConversationSession.id == req.session_id,
                    ConversationSession.user_id == user_id,
                )
            )).scalars().first()
        is_new_session = False
        if not session:
            session_count = (await db.execute(
                select(func.count()).select_from(ConversationSession)
                .where(ConversationSession.user_id == user_id)
            )).scalar_one()
            if session_count >= 50:
                oldest = (await db.execute(
                    select(ConversationSession)
                    .where(ConversationSession.user_id == user_id)
                    .order_by(ConversationSession.updated_at.asc())
                    .limit(1)
                )).scalars().first()
                if oldest:
                    await db.delete(oldest)
            session = ConversationSession(user_id=user_id, title=(req.message[:50] or "新对话"), source=getattr(req, "source", "web"))
            db.add(session)
            await db.flush()
            is_new_session = True
        session_id = session.id

        # 历史窗口：最新若干条 → 按 token 预算从新往回裁剪
        hist_res = await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == session_id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(tokens.HISTORY_MAX_MSGS)
        )
        history = tokens.select_history(hist_res.scalars().all(), token_budget=model_cfg.context_tokens)

        # 附件（IM 收到的文件）：文本读内容注入给模型，卡片随用户消息持久化（和网页同一套）
        from app.core import chat_attach
        aug_text, attach_cards, aug_images = await chat_attach.resolve_for_message(
            user_id, getattr(req, "attachments", None) or [], req.message)
        db.add(ConversationMessage(session_id=session_id, role="user", content=req.message,
                                   files=attach_cards or None))
        await db.commit()

    # IM 来的用户消息：一存下就先推给网页（先看到「我发了什么」，咕咕回复生成完再推第二次），
    # 而不是等一轮结束把一来一回一起推。events 是局部变量（日历列表），用别名导模块。
    try:
        from app.core import events as _evmod
        await _evmod.publish(user_id, "sessions", session_id=session_id,
                             appended=[{"role": "user", "text": req.message, "files": attach_cards or None}])
    except Exception:
        pass

    memory = await loaders.load_memory(user_id) if profile.memory_enabled else {}
    prompt_name = profile.prompt_file.removesuffix(".md")
    system_prompt = builder.build(
        prompt_name, req.user_name, projects, events, memory, files_overview,
        skills=profile.skills, style_prefs=style_prefs,
    )

    # 对话摘要：从历史弹出 summary 条，注入 system prompt（不能当 role="summary" 消息发给 LLM）
    from agent.context import compress_conv
    _summary, history = compress_conv.pop_summary(history)
    if _summary:
        system_prompt += compress_conv.system_block(_summary)

    from agent.llm_select import use_anthropic_for
    use_anthropic = use_anthropic_for(model_cfg)
    runner = LLMRunner(profile.tool_names, settings)

    from app.core.chat_attach import build_user_content
    anthr_messages: list = []
    anthr_initial_len = 0
    if use_anthropic:
        for h in history:
            content = h.content_json if h.content_json is not None else (h.content or "")
            anthr_messages.append({"role": h.role, "content": content})
        anthr_messages.append({"role": "user", "content": build_user_content(aug_text, aug_images, True)})
        anthr_initial_len = len(anthr_messages)
        gen = runner.run(user_id, system_prompt, anthr_messages, use_anthropic=True, model_cfg=model_cfg)
    else:
        oa_messages = [{"role": "system", "content": system_prompt}]
        for h in history:
            oa_messages.append({"role": h.role, "content": h.content or ""})
        oa_messages.append({"role": "user", "content": build_user_content(aug_text, aug_images, False)})
        gen = runner.run(user_id, None, oa_messages, use_anthropic=False, model_cfg=model_cfg)

    try:
        text, tin, tout, errored, sent_files, cancelled = await _collect(gen)
    finally:
        _release_model(model_cfg)   # least_loaded：请求结束减在途计数（其他方式 no-op）

    # 用户中途「算了」：网关已回「先不继续啦」，这里不再补发/不入历史/不反思（已执行的工具效果保留）
    if cancelled:
        return AgentResponse(text="", session_id=session_id, tokens_in=tin, tokens_out=tout, cancelled=True)

    # IM 出口兜底：发给用户/持久化之前确定性清洗（抹 tool_id 噪声、拦系统提示词泄露）
    if not errored:
        from agent.outbound import sanitize_outbound
        text = sanitize_outbound(text)
        text = sanitize.strip_disallowed_emoji(text)   # 出口兜底删白名单外 emoji（prompt 压不住）

    # ── 持久化：工具调用轮次（anthropic）+ 回复 + 用量（报错不入历史）──
    if not errored:
        async with _sess._SessionLocal() as db2:
            if use_anthropic:
                for tm in anthr_messages[anthr_initial_len:]:
                    db2.add(ConversationMessage(
                        session_id=session_id, role=tm["role"],
                        content="", content_json=chat_attach.strip_vision_for_history(tm["content"]),
                    ))
            if text or sent_files:
                db2.add(ConversationMessage(session_id=session_id, role="assistant",
                                            content=text, files=sent_files or None))
            # 按 6h 剩余额度封顶本轮用量（精力条最多 100%，顶过线只记填满部分，超出不计 6h 与周）；已满则 (0,0) 不写
            _cap_in, _cap_out = await quota.cap_usage(db2, user_id, settings, tin, tout)
            if _cap_in or _cap_out:
                db2.add(AgentUsage(
                    user_id=user_id, session_id=session_id,
                    tokens_in=_cap_in, tokens_out=_cap_out,
                    model=model_cfg.model, provider=model_cfg.provider,
                ))
            await db2.commit()

        # 新会话标题：移出关键路径，后台生成（会话已有首句截断做临时标题，好了再异步升级+推事件）。
        # 闲置后「重新聊天」=新会话，原来要在回复后再串行等一次 LLM 起标题才返回 → 慢一倍，这里去掉。
        if is_new_session and text:
            _schedule_title(user_id, session_id, req.message, text, settings, use_anthropic)

        # 推第二次：咕咕的回复（用户消息已在生成前先推过，这里只补助手消息，
        # 网页就「先看到我发的、再看到回答」，而不是一轮结束一次性蹦出来）
        try:
            from app.core import events as _evmod
            if text or sent_files:
                await _evmod.publish(user_id, "sessions", session_id=session_id,
                                     appended=[{"role": "assistant", "text": text, "files": sent_files or None}])
            else:
                await _evmod.publish(user_id, "sessions", session_id=session_id)  # 至少 bump 列表
        except Exception:
            pass

        # 对话后反思（fire-and-forget）
        if profile.memory_enabled and text:
            from agent.memory import reflection
            reflection.schedule(user_id, req.user_name, req.message, text, settings)

        # 对话压缩（fire-and-forget）
        from agent.context import compress_conv
        compress_conv.schedule(session_id, user_id, settings, model_cfg.context_tokens)

    return AgentResponse(text=text, session_id=session_id, tokens_in=tin, tokens_out=tout, files=sent_files)


async def _collect(gen: AsyncGenerator[str, None]) -> tuple[str, int, int, bool, list]:
    """消费 LLMRunner 的 SSE 流：清洗后攒文本 + 取用量 + 收集咕咕要发的文件。
    返回 (文本, in, out, errored, files)；errored=True 时文本是错误文案（不入历史/不反思）。

    文本**按轮分段收集、结尾去重拼接**：MiniMax 多轮工具调用时常把上一轮的开场白
    整段重述一遍，无脑拼接会让开场白叠 N 遍（QQ 还会把口语的 ~ 渲染成删除线）。
    """
    san = sanitize.StreamSanitizer()
    rounds: list[str] = []   # 每轮文本分开存
    cur = ""
    tin = tout = 0
    files: list = []
    cancelled = False
    async for evt_str in gen:
        try:
            evt = json.loads(evt_str[6:])
        except Exception:
            continue
        t = evt.get("type")
        if t == "_new_round":
            cur += san.flush()
            rounds.append(cur)
            cur = ""
            san = sanitize.StreamSanitizer()  # 新一轮重置清洗器
        elif t == "_usage":
            tin = evt.get("input", 0)
            tout = evt.get("output", 0)
        elif t == "token":
            cur += san.feed(evt.get("content", ""))
        elif t == "file" and evt.get("file"):
            files.append(evt["file"])   # 咕咕用 send_file 工具要发的文件
        elif t == "_cancelled":
            cancelled = True   # 用户中途「算了」：停止收集，网关已回「先不继续」，worker 不再补发
            break
        elif t == "error":
            return (evt.get("message") or "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？", tin, tout, True, files, False)
    cur += san.flush()
    rounds.append(cur)

    # 去重拼接：若本轮以上一轮全文为前缀（模型重述了开场白），用本轮替换上一轮，不叠加
    parts: list[str] = []
    for r in rounds:
        r = r.strip()
        if not r:
            continue
        if parts and r.startswith(parts[-1]):
            parts[-1] = r
        else:
            parts.append(r)
    return ("".join(parts).strip(), tin, tout, False, files, cancelled)


async def run_ephemeral(user_id, user_name: str, prompt: str) -> str:
    """定时任务专用：跑 agent 拿结果，不建 session、不存 DB、不推 SSE。"""
    profile = DefaultProfile()
    settings = get_settings()
    model_cfg = pick_model(settings, None)   # 解析层：active/pool/router 选一个模型配置

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()

    async with _sess._SessionLocal() as db:
        projects = await loaders.load_projects(db, user_id)
        events = await loaders.load_events(db, user_id)
        files_overview = await loaders.load_files_overview(db, user_id)

    memory = await loaders.load_memory(user_id) if profile.memory_enabled else {}
    prompt_name = profile.prompt_file.removesuffix(".md")
    system_prompt = builder.build(prompt_name, user_name, projects, events, memory, files_overview, skills=profile.skills)

    from agent.llm_select import use_anthropic_for
    use_anthropic = use_anthropic_for(model_cfg)
    runner = LLMRunner(profile.tool_names, settings)

    from app.core.chat_attach import build_user_content
    if use_anthropic:
        messages = [{"role": "user", "content": build_user_content(prompt, [], True)}]
        gen = runner.run(user_id, system_prompt, messages, use_anthropic=True, model_cfg=model_cfg)
    else:
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}]
        gen = runner.run(user_id, None, messages, use_anthropic=False, model_cfg=model_cfg)

    try:
        text, _, _, errored, _, _ = await _collect(gen)
    finally:
        _release_model(model_cfg)   # least_loaded：请求结束减在途计数（其他方式 no-op）
    return sanitize.strip_disallowed_emoji(text) if not errored else ""
