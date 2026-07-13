"""非流式 runner：把 LLMRunner 的流式工具循环收成"完整一段"回复。

bot 平台（飞书/QQ/微信）不流式，要的是攒完整段一次性发。复用 loaders/builder/
core/sanitize 这套大脑，把 SSE 流"消费成文本"。会话历史/持久化/反思与 web 同口径：
按 session_id 找/建会话、读历史窗口、存用户+回复消息、对话后反思。session_id 由
worker 按平台用户从 Redis 取（续聊不断），见 worker._im_session_*。
"""
from __future__ import annotations
from app.core.tz import now_utc, set_ctx_tz

import asyncio
import json
import logging
from typing import AsyncGenerator, AsyncIterator, List, Tuple

logger = logging.getLogger(__name__)

from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.redaction import redact
from agent import sanitize, quota
from agent.context import builder, loaders, tokens
from agent.core import LLMRunner
from agent.llm_select import is_minimax, pick_model, release as _release_model
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


def _with_quoted_context(message: str, quoted_text: str | None) -> str:
    """给模型看的输入：引用/回复场景下把被引用原文包进去。只在**喂给模型**这一步用，
    不能拿它当 ConversationMessage.content 存/当网页展示文本——那样会把引用原文（可能带
    markdown 表格等）直接拼进用户消息正文，网页气泡按纯文本渲染，会被原样摊平显示得很难看
    （devlog 2026-07-10）。展示层面引用原文走 quoted_text 单独一列，前端另起一个引用预览块。"""
    if not quoted_text:
        return message
    return f"💬 用户引用/回复了一条历史消息（原文：「{quoted_text}」），针对这条消息说：\n\n{message}"


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
    age_h = (now_utc() - prev.updated_at).total_seconds() / 3600
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
        user_tz = await loaders.load_user_tz(db, user_id)   # 「今天」按用户时区算（Phase 3）
        set_ctx_tz(user_tz)                                 # tool dispatch 深处（overview 等）也能读到
        events = await loaders.load_events(db, user_id, tz=user_tz)
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
        llm_text = _with_quoted_context(req.message, getattr(req, "quoted_text", None))
        aug_text, attach_cards, aug_images, aug_media = await chat_attach.resolve_for_message(
            user_id, getattr(req, "attachments", None) or [], llm_text, model_cfg=model_cfg)
        if getattr(req, "attachments", None):   # 诊断：带附件时记 kind/ext/media 数，排查语音为何没转写
            import logging as _lg
            _lg.getLogger("agent.runner").info(
                "[语音诊断] attach=%d aug_media=%d kinds=%s exts=%s",
                len(req.attachments or []), len(aug_media or []),
                [c.get("kind") for c in (attach_cards or [])],
                [c.get("ext") for c in (attach_cards or [])])
        db.add(ConversationMessage(session_id=session_id, role="user", content=req.message,
                                   files=attach_cards or None, quoted_text=getattr(req, "quoted_text", None)))
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
                             appended=[{"role": "user", "text": req.message, "files": attach_cards or None,
                                       "quoted_text": getattr(req, "quoted_text", None)}])
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
        non_streaming=True,     # run_collect 是 IM 专用（worker.py 调用），不流式展示给用户
        user_tz=user_tz,
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
        text, tin, tout, errored, sent_files, cancelled = await _collect(gen, minimax=is_minimax(model_cfg))
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
                # 只落真工具往返；守卫注入的合成 prompt / 核实内心戏是控制信令，不进历史（否则每轮重灌污染上下文）
                for tm in sanitize.tool_rounds_only(anthr_messages[anthr_initial_len:]):
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


# ── 流式版本（飞书 send_text_stream 用，2026-07-09 接入）──────────────────────
# run_collect 的"流式"变体：行为完全一致（同样的 loads / 记忆 / 工具循环 / 持久化 / 反思），
# 唯一差别是消费 LLMRunner 流时逐字 yield token，让飞书 IM 端能实时 patch 卡片（参见 feishu.py
# send_text_stream）。
#
# Yield 类型（call 端用 isinstance 区分）：
#   ("token", str)            — 已过 StreamSanitizer 清洗的逐字片段
#   ("final", AgentResponse)  — 生成结束，含完整 text/files/cancelled/session_id/tokens
#                                session_id 来自 run_collect 同款会话创建流程（line 165-193）
#                                持久化 / 反思 / 压缩跟 run_collect 完全一致
async def run_stream(req: AgentRequest) -> AsyncIterator[tuple[str, object]]:
    """run_collect 的流式版本：逐字 yield token + 末尾 yield AgentResponse。"""
    user_id = req.user_id
    profile = DefaultProfile()
    settings = get_settings()
    model_cfg = pick_model(settings, req)

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import (
        AgentUsage, ConversationMessage, ConversationSession,
    )

    async with _sess._SessionLocal() as db:
        projects = await loaders.load_projects(db, user_id)
        user_tz = await loaders.load_user_tz(db, user_id)   # 「今天」按用户时区算（Phase 3）
        set_ctx_tz(user_tz)                                 # tool dispatch 深处（overview 等）也能读到
        events = await loaders.load_events(db, user_id, tz=user_tz)
        files_overview = await loaders.load_files_overview(db, user_id)
        style_prefs = await loaders.load_style_prefs(db, user_id)

        # ── 会话 get / create（跟 run_collect 同款）──
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

        # 历史窗口
        hist_res = await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == session_id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(tokens.HISTORY_MAX_MSGS)
        )
        history = tokens.select_history(hist_res.scalars().all(), token_budget=model_cfg.context_tokens)
        _nonsumm = [h for h in history if getattr(h, "role", None) != "summary"]
        _proactive_lead = _nonsumm[0].content if _nonsumm and _nonsumm[0].role == "assistant" else ""

        from app.core import chat_attach
        llm_text = _with_quoted_context(req.message, getattr(req, "quoted_text", None))
        aug_text, attach_cards, aug_images, aug_media = await chat_attach.resolve_for_message(
            user_id, getattr(req, "attachments", None) or [], llm_text, model_cfg=model_cfg)
        db.add(ConversationMessage(session_id=session_id, role="user", content=req.message,
                                   files=attach_cards or None, quoted_text=getattr(req, "quoted_text", None)))
        await db.commit()

        if await quota.is_exhausted(db, user_id, settings):
            yield ("final", AgentResponse(text="咕咕累了，休息会儿再来～", session_id=session_id,
                                          tokens_in=0, tokens_out=0))
            return

        im_bridge = ""
        if is_new_session and getattr(req, "source", None) in _IM_SOURCES:
            try:
                im_bridge = await _im_continuity_bridge(db, user_id, session_id, req.message)
            except Exception:
                im_bridge = ""

    # 用户消息先推给网页（跟 run_collect 一致）
    try:
        from app.core import events as _evmod
        await _evmod.publish(user_id, "sessions", session_id=session_id,
                             appended=[{"role": "user", "text": req.message, "files": attach_cards or None,
                                       "quoted_text": getattr(req, "quoted_text", None)}])
    except Exception:
        pass

    # 语音转写（跟 run_collect 一致）：不支持时直接结束
    if aug_media:
        from agent import voice as _voice
        transcript = await _voice.transcribe(aug_media, settings)
        if transcript is None:
            _release_model(model_cfg)
            yield ("final", AgentResponse(
                text="抱歉，我现在还不能处理语音 / 音视频消息哦，打字告诉我就行～",
                session_id=session_id, tokens_in=0, tokens_out=0))
            return
        spoken = transcript.strip() or "（用户发来一段语音，但这次没听清内容）"
        aug_text = (aug_text + "\n" if aug_text else "") + f"（用户发来语音，内容是：）{spoken}"
        aug_media = []

    memory = await loaders.load_memory(user_id, req.message) if profile.memory_enabled else {}
    im_channels = await loaders.load_im_channels(user_id)
    prompt_name = profile.prompt_file.removesuffix(".md")
    system_prompt = builder.build(
        prompt_name, req.user_name, projects, events, memory, files_overview,
        skills=profile.skills, style_prefs=style_prefs,
        source=getattr(req, "source", None), im_channels=im_channels,
        user_msg=req.message,
        non_streaming=False,     # ★ 流式：让 core.py 走流式生成路径（不走 builder._NON_STREAMING_BLOCK 抑制）
        user_tz=user_tz,
    )
    if im_bridge:
        system_prompt += im_bridge
    if _proactive_lead:
        system_prompt += "\n\n## 你刚主动发给 TA 的消息（TA 接下来很可能在回应这条）\n\n" + _proactive_lead

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
        anthr_messages = sanitize.sanitize_messages(anthr_messages)
        anthr_initial_len = len(anthr_messages)
        gen = runner.run(user_id, system_prompt, anthr_messages, use_anthropic=True, model_cfg=model_cfg)
    else:
        oa_messages = [{"role": "system", "content": system_prompt}]
        for h in history:
            oa_messages.append({"role": h.role, "content": h.content or ""})
        oa_messages.append({"role": "user", "content": build_user_content(aug_text, aug_images, False, media=aug_media)})
        gen = runner.run(user_id, None, oa_messages, use_anthropic=False, model_cfg=model_cfg)

    # ── 流式消费 generator（替代 _collect：逐字 yield + 末尾 yield final）──
    minimax_stream = is_minimax(model_cfg)
    san = sanitize.StreamSanitizer(minimax=minimax_stream)
    rounds: list[str] = []
    cur = ""
    tin = tout = 0
    files: list = []
    cancelled = False
    errored = False
    errored_text = ""
    try:
        async for evt_str in gen:
            try:
                evt = json.loads(evt_str[6:])  # strip "data: "
            except Exception:
                continue
            t = evt.get("type")
            if t == "_new_round":
                cur += san.flush()
                rounds.append(cur)
                cur = ""
                san = sanitize.StreamSanitizer(minimax=minimax_stream)
            elif t == "_usage":
                tin = evt.get("input", 0)
                tout = evt.get("output", 0)
            elif t == "token":
                # 走同一清洗器（跟 _collect 一致）保证输出文本跟 run_collect 完全等价
                token = san.feed(evt.get("content", ""))
                cur += token
                if token:
                    yield ("token", token)
            elif t == "file" and evt.get("file"):
                files.append(evt["file"])
            elif t == "_cancelled":
                cancelled = True
                break
            elif t == "error":
                errored_text = evt.get("message") or evt.get("detail") or "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
                errored = True
                break
    finally:
        _release_model(model_cfg)

    if cancelled:
        yield ("final", AgentResponse(text="", session_id=session_id,
                                      tokens_in=tin, tokens_out=tout, cancelled=True))
        return

    if not errored:
        cur += san.flush()
        rounds.append(cur)
        text = ""
        for r in reversed(rounds):
            r = r.strip()
            if r:
                text = r
                break
    else:
        text = errored_text

    # 出口兜底清洗（跟 run_collect 一致）
    if not errored:
        from agent.outbound import sanitize_outbound
        text = sanitize_outbound(text)
        text = sanitize.strip_disallowed_emoji(text)

    # 持久化（跟 run_collect 一致）：写入 db + schedule_title/summary/reflection/compress
    if not errored:
        async with _sess._SessionLocal() as db2:
            if use_anthropic:
                # 只落真工具往返；守卫注入的合成 prompt / 核实内心戏是控制信令，不进历史（否则每轮重灌污染上下文）
                for tm in sanitize.tool_rounds_only(anthr_messages[anthr_initial_len:]):
                    db2.add(ConversationMessage(
                        session_id=session_id, role=tm["role"],
                        content="", content_json=chat_attach.strip_vision_for_history(tm["content"]),
                    ))
            if text or files:
                db2.add(ConversationMessage(session_id=session_id, role="assistant",
                                            content=text, files=files or None))
            _cap_in, _cap_out = await quota.cap_usage(db2, user_id, settings, tin, tout)
            if _cap_in or _cap_out:
                db2.add(AgentUsage(
                    user_id=user_id, session_id=session_id,
                    tokens_in=_cap_in, tokens_out=_cap_out,
                    model=model_cfg.model, provider=model_cfg.provider,
                ))
            await db2.commit()

        if is_new_session and text:
            _schedule_title(user_id, session_id, req.message, text, settings, use_anthropic)
        if text:
            _schedule_summary(user_id, session_id, is_new_session, settings, use_anthropic)

        try:
            from app.core import events as _evmod
            if text or files:
                await _evmod.publish(user_id, "sessions", session_id=session_id,
                                     appended=[{"role": "assistant", "text": text, "files": files or None}])
            else:
                await _evmod.publish(user_id, "sessions", session_id=session_id)
        except Exception:
            pass

        if profile.memory_enabled and text:
            from agent.memory import reflection
            im_used_tools = use_anthropic and len(anthr_messages) > anthr_initial_len
            reflection.schedule(user_id, req.user_name, req.message, text, settings,
                                used_tools=im_used_tools, session_id=session_id)

        from agent.context import compress_conv as _cc
        _cc.schedule(session_id, user_id, settings, model_cfg.context_tokens)

    yield ("final", AgentResponse(text=text, session_id=session_id, tokens_in=tin,
                                  tokens_out=tout, files=files, cancelled=False))


async def _collect(
    gen: AsyncGenerator[str, None], minimax: bool = False,
) -> Tuple[str, int, int, bool, List, bool]:
    """消费 LLMRunner 的 SSE 流：清洗后攒文本 + 取用量 + 收集咕咕要发的文件。
    返回 (文本, in, out, errored, files)；errored=True 时文本是错误文案（不入历史/不反思）。

    文本**按轮分段收集，只取最后一轮**：这条路径（run_collect/run_ephemeral）不流式展示给
    用户，工具调用之间模型说的过渡性旁白（"我先查一下""这条数据不对我再试试"）不该被当成
    正文发出去——之前拼接所有轮次+简单去重，会把这些旁白原样推给用户（真实翻车案例：定时
    任务查天气时反复重试，旁白被整段推送）。配合 builder._NON_STREAMING_BLOCK 提示模型把
    完整答案收在最后一轮，这里只取 rounds[-1]（若为空则回退到最近一条非空轮次，不让用户
    啥也没收到）。
    """
    san = sanitize.StreamSanitizer(minimax=minimax)
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
            san = sanitize.StreamSanitizer(minimax=minimax)  # 新一轮重置清洗器
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
            detail = evt.get("message") or evt.get("detail") or "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
            return (detail, tin, tout, True, files, False)
    cur += san.flush()
    rounds.append(cur)

    text = ""
    for r in reversed(rounds):
        r = r.strip()
        if r:
            text = r
            break
    return (text, tin, tout, False, files, cancelled)


def _resolve_ephemeral_tool_names(tool_groups: list[str] | None, profile_tool_names: list[str]) -> list[str]:
    """按 context_config.tool_groups 精简工具集；组名有不认识的（改名/拼写错误/枚举漂移）
    就不信这份结果，退回全量，安全优先于省 token（同 run_ephemeral 里"判断不出来就走全量"
    是同一个原则）。"""
    if not tool_groups:
        return profile_tool_names
    from agent.tools import registry
    unknown = [g for g in tool_groups if g not in registry.known_skill_names()]
    if unknown:
        print(f"[runner] tool_groups 里有未知组名 {unknown}，退回全量工具集", flush=True)
        return profile_tool_names
    # meta（use_skill）恒带上，不管分类判断有没有选它——漏了这一组，天气等按需 skill 就彻底
    # 拉不到，属于「功能直接坏掉」而不是「多花点 token」，安全代价不对等，不能只信分类结果。
    return registry.tools_of(list(set(tool_groups) | {"meta"}))


# 定时任务失败后延迟重试的等待时长（秒）。排查记录（2026-07-12/13 连续两天「科技新闻」
# 任务撞上 MiniMax `input new_sensitive` 内容审核拒绝）：同一次执行内部几秒间隔的 3 次
# 自动重试全部同样失败，但用户手动隔几分钟再触发一次相同任务总能成功——不是审核系统本身
# 随机，而是这条路径每次都会带着当下最新的动态上下文（当前时间、项目/日历/记忆快照，见
# _run_ephemeral_once 里的 loaders 调用）重新拼一次系统提示词，隔几分钟后这份上下文本来
# 就已经不一样了，构成一次真正意义上不同的请求，不是对同一次审核判定的重放。所以这里选了
# 一个"足够让上下文有机会变化"的分钟级延迟，不是随手挑的秒数；短于这个值意义不大（跟当次
# 执行内部那 3 次秒级重试没区别，验证过全部同样失败）。
_EPHEMERAL_RETRY_DELAY_S = 90


async def _run_ephemeral_once(user_id, user_name: str, prompt: str, profile, settings,
                              context_config: dict | None) -> tuple[str, bool]:
    """单次真正执行一趟 run_ephemeral（加载上下文→拼提示词→跑 LLM→收集结果），
    被 run_ephemeral 调用一到两次（首次 + 失败后的延迟重试）。返回 (文本, 是否出错)。"""
    model_cfg = pick_model(settings, None)   # 解析层：active/pool/router 选一个模型配置
    try:
        cfg = context_config or {}
        inc_projects = bool(cfg.get("projects")) if context_config else True
        inc_calendar = bool(cfg.get("calendar")) if context_config else True
        inc_files    = bool(cfg.get("files"))    if context_config else True
        inc_memory   = bool(cfg.get("memory"))   if context_config else True

        import app.db.session as _sess
        if _sess._engine is None:
            _sess._build_engine()

        async with _sess._SessionLocal() as db:
            projects = await loaders.load_projects(db, user_id) if inc_projects else []
            user_tz = await loaders.load_user_tz(db, user_id)   # 「今天」按用户时区算（Phase 3）
            set_ctx_tz(user_tz)                                 # tool dispatch 深处（overview 等）也能读到
            events = await loaders.load_events(db, user_id, tz=user_tz) if inc_calendar else []
            files_overview = await loaders.load_files_overview(db, user_id) if inc_files else None

        memory = await loaders.load_memory(user_id) if (profile.memory_enabled and inc_memory) else {}
        im_channels = await loaders.load_im_channels(user_id)
        prompt_name = profile.prompt_file.removesuffix(".md")
        system_prompt = builder.build(prompt_name, user_name, projects, events, memory, files_overview,
                                      skills=profile.skills, im_channels=im_channels, non_streaming=True,
                                      include_projects=inc_projects, include_calendar=inc_calendar,
                                      include_files=inc_files, include_memory=inc_memory,
                                      user_tz=user_tz)

        from agent.llm_select import use_anthropic_for
        use_anthropic = use_anthropic_for(model_cfg)
        tool_groups = context_config.get("tool_groups") if context_config else None
        tool_names = _resolve_ephemeral_tool_names(tool_groups, profile.tool_names)
        runner = LLMRunner(tool_names, settings)

        from app.core.chat_attach import build_user_content
        if use_anthropic:
            messages = [{"role": "user", "content": build_user_content(prompt, [], True)}]
            gen = runner.run(user_id, system_prompt, messages, use_anthropic=True, model_cfg=model_cfg)
        else:
            messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}]
            gen = runner.run(user_id, None, messages, use_anthropic=False, model_cfg=model_cfg)

        text, _, _, errored, _, _ = await _collect(gen, minimax=is_minimax(model_cfg))
        return text, errored
    finally:
        _release_model(model_cfg)   # least_loaded：请求结束减在途计数（其他方式 no-op）


async def run_ephemeral(user_id, user_name: str, prompt: str, context_config: dict | None = None) -> str:
    """定时任务专用：跑 agent 拿结果，不建 session、不存 DB、不推 SSE。

    context_config（来自 ScheduledTask.context_config，创建/改任务时顺手判断出来的）非空时按需
    精简：只加载/注入这个任务真正用得上的工具组和项目/日历/文件/记忆——这条路径不建 session、
    没有 prompt 缓存，每次触发都是全价，省下来的是真金白银。None（没判断出结果的旧任务/默认值）
    就走全量，安全优先。

    失败会自动重试一次（延迟 _EPHEMERAL_RETRY_DELAY_S 秒），不是简单重放同一份请求——
    _run_ephemeral_once 每次都重新从 DB 加载上下文、重新拼系统提示词，重试时用户看到的是
    一次带着最新上下文的独立请求。定时任务是异步推送结果的后台流程，没有人盯着转圈等，
    多等一两分钟换来自动挽回一次性误判/供应商侧瞬时状态，比让用户自己发现失败再手动重试划算。
    """
    profile = DefaultProfile()
    settings = get_settings()

    text, errored = await _run_ephemeral_once(user_id, user_name, prompt, profile, settings, context_config)
    if errored:
        # 定时任务排障日志：_collect 判定失败时会把 text 换成错误详情，但调用方（scheduled_tasks.py）
        # 只看得到这里返回的文本，兜成通用「没有产出内容」——真实原因此前完全没留痕（2026-07-11
        # 排查「科技新闻」任务空产出时，日志里既无 LLM 报错、也无工具调用记录，无从判断）。
        logger.warning("[定时任务] run_ephemeral 首次失败，%s 秒后重试一次: %s", _EPHEMERAL_RETRY_DELAY_S, redact(text))
        await asyncio.sleep(_EPHEMERAL_RETRY_DELAY_S)
        text, errored = await _run_ephemeral_once(user_id, user_name, prompt, profile, settings, context_config)
        if errored:
            logger.warning("[定时任务] run_ephemeral 重试后仍失败: %s", redact(text))
    return sanitize.strip_disallowed_emoji(text)
