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


async def _gen_summary_bg(user_id, session_id, force: bool, settings, use_anthropic: bool) -> None:
    """后台给会话生成/刷新「一句话总结」（供跨 session 查找 + 续接桥指针）。
    新会话强制出一版；之后每 ~6 条消息刷新一次、跟着话题走。不计精力（同标题）。"""
    try:
        import app.db.session as _sess
        from app.models import ConversationSession, ConversationMessage
        from sqlalchemy import select as _select, func as _func, desc as _desc
        async with _sess._SessionLocal() as db:
            cnt = (await db.execute(
                _select(_func.count()).select_from(ConversationMessage)
                .where(ConversationMessage.session_id == session_id,
                       ConversationMessage.content_json.is_(None)))).scalar_one()
            if not force and (cnt < 4 or cnt % 6 != 0):
                return                              # 没到刷新点就跳过，省 LLM 调用
            rows = (await db.execute(
                _select(ConversationMessage)
                .where(ConversationMessage.session_id == session_id,
                       ConversationMessage.content_json.is_(None))
                .order_by(_desc(ConversationMessage.created_at)).limit(12))).scalars().all()
            rows = [m for m in reversed(rows) if m.content]
        if not rows:
            return
        convo = "\n".join(
            f"{'用户' if m.role == 'user' else '咕咕'}：{(m.content or '')[:200]}" for m in rows)
        from agent.adapters.web import _generate_summary
        summary = await _generate_summary(convo, settings, use_anthropic)
        if not summary:
            return                                  # 失败回空 → 不覆盖原总结
        async with _sess._SessionLocal() as db:
            s = await db.get(ConversationSession, session_id)
            if s:
                s.summary = summary
                await db.commit()
    except Exception:
        pass


def _schedule_summary(user_id, session_id, force: bool, settings, use_anthropic: bool) -> None:
    task = asyncio.create_task(_gen_summary_bg(user_id, session_id, force, settings, use_anthropic))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


_IM_SOURCES = ("feishu", "qqbot", "wechat")
_CONTINUE_CUES = ("继续", "刚刚", "刚才", "刚说", "刚聊", "上次", "上回", "之前",
                  "接着", "那个事", "那件事", "没续上")


async def _im_continuity_bridge(db, user_id, current_session_id, user_msg: str) -> str:
    """IM 新会话开场的「续接桥」：IM 会话是 12h 滑动 TTL，过期会起一条新空会话，咕咕会丢掉
    上一条的上下文（「没续上之前的聊天」根因）。这里趁 db 还开着补两档：
      A 档（总给）：一行「上一条对话」指针，带 session id —— 让模型（尤其 mimo）知道去
                   `read_conversation(id)` 翻，而不是空着答或拿别的话题顶上。
      B 档（这句像要接着聊时）：直接把上一条尾部几轮塞进上下文，不靠模型自觉调工具。
    上一条太久远（>48h）则不当「刚刚」、整体不注入（防把陈年对话当最近的翻出来）。"""
    from datetime import datetime
    from sqlalchemy import desc as _desc
    from app.models import ConversationSession, ConversationMessage
    prev = (await db.execute(
        select(ConversationSession)
        .where(ConversationSession.user_id == user_id,
               ConversationSession.id != current_session_id)
        .order_by(_desc(ConversationSession.updated_at)).limit(1))).scalars().first()
    if not prev or not prev.updated_at:
        return ""
    age_h = (datetime.utcnow() - prev.updated_at).total_seconds() / 3600
    if age_h > 48:
        return ""
    when = f"约 {int(age_h)} 小时前" if age_h >= 1 else f"约 {max(1, int(age_h * 60))} 分钟前"
    title = (prev.title or "").strip() or "（无标题）"
    gist = (prev.summary or "").strip()
    gist_str = f"——{gist}" if gist else ""
    block = (f"\n\n---\n\n## 最近一条对话（用户可能想接着聊）\n"
             f"上一条对话 #{prev.id}《{title}》{gist_str}，{when}结束。**用户若说「继续 / 刚刚 / 上次 / 之前那次」，"
             f"多半指的是它**——用 `read_conversation({prev.id})` 把它翻出来再接，别空着答、也别拿别的话题顶上。")
    if any(c in (user_msg or "") for c in _CONTINUE_CUES):
        rows = (await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == prev.id,
                   ConversationMessage.content_json.is_(None))
            .order_by(_desc(ConversationMessage.created_at)).limit(8))).scalars().all()
        rows = [m for m in reversed(rows) if m.content]
        if rows:
            tail = "\n".join(
                f"- {'用户' if m.role == 'user' else '咕咕'}：{(m.content or '')[:200]}" for m in rows)
            block += "\n\n这句像是要接着上一条聊，下面是那条对话的最近几轮，**直接据此接上**：\n" + tail
    return block


async def run_collect(req: AgentRequest) -> AgentResponse:
    """找/建会话 + 读历史 → 跑工具循环 → 攒完整回复 + 存盘 + 反思。"""
    user_id = req.user_id
    profile = DefaultProfile()
    settings = get_settings()
    model_cfg = pick_model(settings, req)   # 解析层：active/pool/router 选一个模型配置
    # 不强切 vision 模型：这轮 pick 到的模型看得了图就识图、看不了就当普通文件存（下面 resolve
    # 按 model_cfg 判 vision）。避免硬切到「标了 vision 实则不收图片块」的模型（如 MiniMax 兼容口）。

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
        # 主动推送（定时任务/活动提醒）若是会话首条 assistant（前导，sanitize 会剥掉）→ 记下来塞进 system，
        # 让咕咕知道「自己刚主动发了啥」、能接住用户对它的回复（如新闻速览后用户回「4」）。
        _nonsumm = [h for h in history if getattr(h, "role", None) != "summary"]
        _proactive_lead = _nonsumm[0].content if _nonsumm and _nonsumm[0].role == "assistant" else ""

        # 附件（IM 收到的文件）：文本读内容注入给模型，卡片随用户消息持久化（和网页同一套）
        from app.core import chat_attach
        aug_text, attach_cards, aug_images, aug_media = await chat_attach.resolve_for_message(
            user_id, getattr(req, "attachments", None) or [], req.message, model_cfg=model_cfg)
        if getattr(req, "attachments", None):   # 诊断：带附件时记 kind/ext/media 数，排查语音为何没转写
            import logging as _lg
            _lg.getLogger("agent.runner").info(
                "[语音诊断] attach=%d aug_media=%d kinds=%s exts=%s",
                len(req.attachments or []), len(aug_media or []),
                [c.get("kind") for c in (attach_cards or [])],
                [c.get("ext") for c in (attach_cards or [])])
        db.add(ConversationMessage(session_id=session_id, role="user", content=req.message,
                                   files=attach_cards or None))
        await db.commit()

        # 精力耗尽 → 硬拦（IM / 定时任务，与网页 web.stream 同口径）：用户消息已记，不再生成，直接回一句
        if await quota.is_exhausted(db, user_id, settings):
            return AgentResponse(text="咕咕累了，休息会儿再来～", session_id=session_id,
                                 tokens_in=0, tokens_out=0)

        # IM 新会话「续接桥」：趁 db 还开着查上一条对话，给指针/尾部，免得 12h TTL 起新会话后
        # 用户说「继续刚刚」咕咕空着答（web 有自己的会话续接 + 可手动选历史，无需此桥）。
        im_bridge = ""
        if is_new_session and getattr(req, "source", None) in _IM_SOURCES:
            try:
                im_bridge = await _im_continuity_bridge(db, user_id, session_id, req.message)
            except Exception:
                im_bridge = ""

    # 语音 / 音视频：用独立配置的「语音识别模型」转成文字 → 交主模型，**主模型不再被强切**（见 agent/voice.py）。
    # 没配语音模型 → 切断，回「不支持」（用户消息已存，不再生成）。
    if aug_media:
        from agent import voice as _voice
        transcript = await _voice.transcribe(aug_media, settings)
        if transcript is None:        # 未配置语音模型
            _release_model(model_cfg)
            return AgentResponse(
                text="抱歉，我现在还不能处理语音 / 音视频消息哦，打字告诉我就行～",
                session_id=session_id, tokens_in=0, tokens_out=0)
        spoken = transcript.strip() or "（用户发来一段语音，但这次没听清内容）"
        aug_text = (aug_text + "\n" if aug_text else "") + f"（用户发来语音，内容是：）{spoken}"
        aug_media = []                # 已转文字 → 丢媒体，主模型按文本处理

    # IM 来的用户消息：一存下就先推给网页（先看到「我发了什么」，咕咕回复生成完再推第二次），
    # 而不是等一轮结束把一来一回一起推。events 是局部变量（日历列表），用别名导模块。
    try:
        from app.core import events as _evmod
        await _evmod.publish(user_id, "sessions", session_id=session_id,
                             appended=[{"role": "user", "text": req.message, "files": attach_cards or None}])
    except Exception:
        pass

    memory = await loaders.load_memory(user_id, req.message) if profile.memory_enabled else {}
    im_channels = await loaders.load_im_channels(user_id)
    prompt_name = profile.prompt_file.removesuffix(".md")
    system_prompt = builder.build(
        prompt_name, req.user_name, projects, events, memory, files_overview,
        skills=profile.skills, style_prefs=style_prefs,
        source=getattr(req, "source", None), im_channels=im_channels,
        user_msg=req.message,   # 行为模块软点亮（emotion-first 等）
    )
    if im_bridge:               # IM 新会话续接桥（见 _im_continuity_bridge）
        system_prompt += im_bridge
    if _proactive_lead:         # 主动推送是会话首条 assistant → sanitize 会剥掉，塞 system 兜底
        system_prompt += "\n\n## 你刚主动发给 TA 的消息（TA 接下来很可能在回应这条）\n\n" + _proactive_lead

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
        # 清洗：去孤儿 tool_use/tool_result、空块、块里的 None 字段（MiniMax 严格校验，否则
        # 历史里带非标字段/不配对工具块会报 `text is not set` 等）。**IM 路此前漏了这步，web 路一直有**。
        anthr_messages = sanitize.sanitize_messages(anthr_messages)
        anthr_initial_len = len(anthr_messages)
        gen = runner.run(user_id, system_prompt, anthr_messages, use_anthropic=True, model_cfg=model_cfg)
    else:
        oa_messages = [{"role": "system", "content": system_prompt}]
        for h in history:
            oa_messages.append({"role": h.role, "content": h.content or ""})
        oa_messages.append({"role": "user", "content": build_user_content(aug_text, aug_images, False, media=aug_media)})
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
        # 会话「一句话总结」：新会话先出一版，之后每 ~6 条刷新（跟着话题走）；供 search_conversations + 续接桥
        if text:
            _schedule_summary(user_id, session_id, is_new_session, settings, use_anthropic)

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

        # 对话后反思（fire-and-forget）。IM 用「工具轮次让 anthr_messages 变长」当「咕咕动作了」代理，
        # 这样「嗯」确认后真建改东西的轮也会反思（openai 路径无此代理、回落到 user_msg 判，可接受）。
        if profile.memory_enabled and text:
            from agent.memory import reflection
            im_used_tools = use_anthropic and len(anthr_messages) > anthr_initial_len
            reflection.schedule(user_id, req.user_name, req.message, text, settings,
                                used_tools=im_used_tools, session_id=session_id)

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
