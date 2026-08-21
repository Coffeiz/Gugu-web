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
from types import SimpleNamespace
from typing import AsyncGenerator, AsyncIterator, List, Tuple

from sqlalchemy import delete, desc, func, select

from app.core.config import get_settings
from agent.security import sanitize
from agent import quota
from agent.context import builder, loaders, tokens, session_snapshot, message_assembly
from agent.core import LLMRunner
from agent.im.context_policy import IM_SOURCES, policy_for
from agent.im.context_loader import load_context_data
from agent.im.permissions import filter_tool_names
from agent.im.session import (
    GROUP_CONTEXT_LIMIT,
    get_or_create_session,
    session_scope_filters,
)
from agent.llm.llm_select import is_minimax, pick_model, release as _release_model
from agent.models import AgentRequest, AgentResponse
from agent.profiles import DefaultProfile

# 后台任务引用，防止被 GC（fire-and-forget 的标题生成等）
_bg_tasks: set = set()


def _history_query_limit(request: AgentRequest) -> int:
    """IM 会话（私聊/群聊）从保留池取最近 50 条，Web 会话沿用原窗口。"""
    if request.source in IM_SOURCES:
        return GROUP_CONTEXT_LIMIT
    return tokens.HISTORY_MAX_MSGS


def _im_identity_block(req: AgentRequest, history: list) -> str:
    """把 IM 身份元数据作为内部事实提供给模型，禁止模型凭熟悉感猜身份。"""
    if req.source not in IM_SOURCES:
        return ""
    chat_type = "群聊" if req.chat_id else "私聊"
    role = req.im_role or ("owner" if not req.chat_id else "unknown")
    role_text = {"owner": "绑定 Bot 的用户", "member": "群成员", "unknown": "未确认身份"}.get(role, role)
    lines = [
        "\n\n---\n\n## 当前 IM 身份事实（只供内部核对）",
        f"- 平台：{req.source}",
        f"- 会话类型：{chat_type}",
        f"- 当前发言人平台身份标识：{req.platform_user_id or '未知'}",
        f"- 当前发言人平台显示名：{req.platform_user_name or '未提供'}",
        f"- 当前权限角色：{role_text}",
    ]
    if req.chat_id:
        lines.append(f"- 当前群会话标识：{req.chat_id}")
    previous = [
        getattr(item, "platform_user_id", None)
        for item in history
        if getattr(item, "role", None) == "user" and getattr(item, "platform_user_id", None)
    ]
    if previous:
        lines.append(f"- 当前会话中此前记录到的发言人标识：{', '.join(dict.fromkeys(previous))}")
    lines.extend([
        "- 这是当前消息的可靠元数据，优先级高于历史消息；不要根据昵称、记忆或语气猜测身份。",
        "- 历史消息可能来自其他群成员；回答当前消息时只能使用当前发言人的身份和资料。",
        "- 群聊和私聊是不同会话类型；回答当前消息时必须按这里的会话类型处理。",
        "- 被问到‘是不是同一个 ID’时，只能根据这些标识比较；没有比较依据就明确说目前无法确认，不要编造‘一直没变’。",
        "- 不向用户主动展示原始平台 ID，也不要把 Gugu 账号昵称当成 QQ 昵称。",
        "- 平台显示名只用于自然称呼当前发言人，不能用于身份识别、权限判断或判断是否为同一个人。",
    ])
    return "\n".join(lines)


def _reflection_input(req: AgentRequest, messages: list, initial_len: int, reply: str) -> tuple[str, str]:
    """为 owner 反思隔离群聊内容，只保留 owner 发言和私人工具结果。"""
    if not req.chat_id:
        return req.message, reply
    private_results = []
    for item in messages[initial_len:]:
        if item.get("role") != "tool":
            continue
        content = item.get("content")
        if isinstance(content, list):
            content = "\n".join(
                str(part.get("text") or part.get("content") or "")
                for part in content if isinstance(part, dict)
            )
        if content:
            private_results.append(str(content))
    return req.message, "\n\n".join(private_results) or "（只分析当前 owner 发言，不分析群聊助手回复）"


def _schedule_title(user_id, session_id, user_msg: str, reply_text: str, settings, use_anthropic: bool) -> None:
    """后台生成新会话标题——移出关键路径，别让用户多等一次 LLM 调用（闲置后尤其明显）。"""
    task = asyncio.create_task(_gen_title_bg(user_id, session_id, user_msg, reply_text, settings, use_anthropic))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


async def _gen_title_bg(user_id, session_id, user_msg: str, reply_text: str, settings, use_anthropic: bool) -> None:
    try:
        from agent.gateway.web import _generate_title
        new_title = await _generate_title(user_msg, reply_text, settings, use_anthropic)
        if not new_title:
            return
        import app.db.session as _sess
        from app.models import ConversationSession
        from sqlalchemy import update as _update
        async with _sess._SessionLocal() as db:
            # P1-3：用数据库原子条件 UPDATE 写标题，彻底消除 TOCTOU 竞态。
            # 手动改名（rename_session）会置 title_locked=True；这里只在
            # title_locked=false 时才更新，且 UPDATE 与 rename 的 commit 是
            # 原子串行化的——无论 rename 在哪个时序提交，自动标题都不会覆盖
            # 用户刚改的标题。rowcount==1 才说明本次确实写入了标题。
            result = await db.execute(
                _update(ConversationSession)
                .where(
                    ConversationSession.id == session_id,
                    ConversationSession.title_locked.is_(False),
                )
                .values(title=new_title)
            )
            if result.rowcount != 1:
                # 会话不存在或已被手动改名锁定：不覆盖，也不推送标题事件。
                return
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
        from agent.gateway.web import _generate_summary
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


async def _im_continuity_bridge(db, user_id, current_session_id, user_msg: str,
                                source: str, chat_id: str | None,
                                bot_id: str | None = None,
                                platform_user_id: str | None = None) -> str:
    """IM 新会话开场的「续接桥」：IM 会话是 12h 滑动 TTL，过期会起一条新空会话，咕咕会丢掉
    上一条的上下文（「没续上之前的聊天」根因）。这里趁 db 还开着补两档：
      A 档（总给）：一行「上一条对话」指针，带 session id —— 让模型（尤其 mimo）知道去
                   `read_conversation(id)` 翻，而不是空着答或拿别的话题顶上。
      B 档（这句像要接着聊时）：直接把上一条尾部几轮塞进上下文，不靠模型自觉调工具。
    上一条太久远（>48h）则不当「刚刚」、整体不注入（防把陈年对话当最近的翻出来）。"""
    from datetime import datetime
    from sqlalchemy import desc as _desc
    from app.models import ConversationSession, ConversationMessage
    query = select(ConversationSession).where(
        ConversationSession.user_id == user_id,
        ConversationSession.id != current_session_id,
        *session_scope_filters(ConversationSession, source, chat_id, bot_id, platform_user_id),
    )
    prev = (await db.execute(
        query
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
    context_policy = policy_for(req)
    restricted_im = context_policy.restricted
    # 不强切 vision 模型：这轮 pick 到的模型看得了图就识图、看不了就当普通文件存（下面 resolve
    # 按 model_cfg 判 vision）。避免硬切到「标了 vision 实则不收图片块」的模型（如 MiniMax 兼容口）。

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import (
        AgentUsage, ConversationMessage, ConversationSession,
    )

    async with _sess._SessionLocal() as db:
        session_state = await get_or_create_session(db, req, user_id)
        session, is_new_session = session_state.session, session_state.is_new
        session_id = session.id

        async def _load_snapshot():
            data = await load_context_data(
                db, user_id, req, profile.memory_enabled, req.message, context_policy
            )
            static_prompt, dynamic_context, _ = builder.build_split(
                profile.prompt_file.removesuffix(".md"), req.user_name,
                data.projects, data.events, data.memory, data.files_overview,
                skills=profile.skills, style_prefs=data.style_prefs,
                source=getattr(req, "source", None), im_channels=data.im_channels,
                im_message_format=getattr(req, "im_message_format", None),
                user_msg=req.message, non_streaming=True, user_tz=data.user_tz,
            )
            return {
                "system_prompt": static_prompt,
                "dynamic_context": dynamic_context,
                "session_info": {"user_name": req.user_name, "source": req.source,
                                  "chat_id": req.chat_id, "profile": profile.prompt_file},
                "user_tz": data.user_tz,
                "im_channels": data.im_channels,
                "im_memory": data.im_memory,
                "dynamic_tail": builder.dynamic_tail(data.memory),
            }

        snapshot = await session_snapshot.ensure_snapshot(db, session, load_context=_load_snapshot)
        user_tz = snapshot["user_tz"]
        set_ctx_tz(user_tz)
        context_data = SimpleNamespace(im_memory=snapshot["im_memory"])

        # 历史窗口：最新若干条 → 按 token 预算从新往回裁剪
        hist_res = await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == session_id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(_history_query_limit(req))
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
        user_message = ConversationMessage(session_id=session_id, role="user", content=req.message,
                                           files=attach_cards or None, quoted_text=getattr(req, "quoted_text", None),
                                           platform_user_id=req.platform_user_id,
                                           platform_user_name=req.platform_user_name,
                                           platform_bot_user_id=req.platform_bot_user_id,
                                           chat_type="group" if req.chat_id else "c2c" if req.source in IM_SOURCES else None)
        db.add(user_message)
        await db.flush()
        # 消息 + 所有附件 claim 是同一个事务（PRD-STORAGE-1 不变量 3），同网页路
        try:
            await chat_attach.claim_attachments(
                db, user_id, user_message.id, [c["attach_id"] for c in (attach_cards or [])])
        except chat_attach.AttachmentClaimError:
            await db.rollback()
            return AgentResponse(text="附件已失效（可能已被使用或清理），请重新发送", session_id=session_id)
        await db.commit()

        # 精力耗尽 → 硬拦（IM / 定时任务，与网页 web.stream 同口径）：用户消息已记，不再生成，直接回一句
        if await quota.is_exhausted(db, user_id, settings):
            return AgentResponse(text="咕咕累了，休息会儿再来～", session_id=session_id,
                                 tokens_in=0, tokens_out=0)

        # IM 新会话「续接桥」：趁 db 还开着查上一条对话，给指针/尾部，免得 12h TTL 起新会话后
        # 用户说「继续刚刚」咕咕空着答（web 有自己的会话续接 + 可手动选历史，无需此桥）。
        im_bridge = ""
        if is_new_session and context_policy.allow_continuity_bridge:
            try:
                im_bridge = await _im_continuity_bridge(
                    db,
                    user_id,
                    session_id,
                    req.message,
                    req.source,
                    req.chat_id,
                    req.platform_bot_id,
                    req.platform_user_id,
                )
            except Exception:
                im_bridge = ""

    # 语音 / 音视频：用独立配置的「语音识别模型」转成文字 → 交主模型，**主模型不再被强切**（见 agent/voice.py）。
    # 没配语音模型 → 切断，回「不支持」（用户消息已存，不再生成）。
    _transcribe_media = [m for m in aug_media if m.get("type") != "video"]
    if _transcribe_media:
        from agent import voice as _voice
        transcript = await _voice.transcribe(_transcribe_media, settings)
        if transcript is None:        # 未配置语音模型
            _release_model(model_cfg)
            return AgentResponse(
                text="抱歉，我现在还不能处理语音 / 音视频消息哦，打字告诉我就行～",
                session_id=session_id, tokens_in=0, tokens_out=0)
        spoken = transcript.strip() or "（用户发来一段语音，但这次没听清内容）"
        aug_text = (aug_text + "\n" if aug_text else "") + f"（用户发来语音，内容是：）{spoken}"
        aug_media = [m for m in aug_media if m.get("type") == "video"]

    # IM 来的用户消息：一存下就先推给网页（先看到「我发了什么」，咕咕回复生成完再推第二次），
    # 而不是等一轮结束把一来一回一起推。events 是局部变量（日历列表），用别名导模块。
    try:
        from app.core import events as _evmod
        await _evmod.publish(user_id, "sessions", session_id=session_id,
                             appended=[{"role": "user", "text": req.message, "files": attach_cards or None,
                                       "quoted_text": getattr(req, "quoted_text", None),
                                       "platform_user_id": req.platform_user_id,
                                       "platform_user_name": req.platform_user_name,
                                       "platform_bot_user_id": req.platform_bot_user_id}])
    except Exception:
        pass

    system_prompt = snapshot["system_prompt"]
    dynamic_context = snapshot["dynamic_context"]
    now_str = session_snapshot.current_time_text(user_tz)
    dynamic_tail = builder.dynamic_tail(
        await loaders.load_dynamic_memory(user_id) if profile.memory_enabled else {}
    )

    # 组装动态上下文注入块（放入 messages，不进 system）
    _dynamic_extra_parts = []
    if dynamic_context:
        _dynamic_extra_parts.append(dynamic_context)
    _im_id = _im_identity_block(req, history)
    if _im_id:
        _dynamic_extra_parts.append(_im_id)
    if context_data.im_memory:
        from agent.im.context_loader import format_im_memory
        scope_memory = format_im_memory(context_data.im_memory, req.im_role)
        if scope_memory:
            _dynamic_extra_parts.append(scope_memory)
    if im_bridge:
        _dynamic_extra_parts.append(im_bridge)
    if _proactive_lead:
        _dynamic_extra_parts.append("\n## 你刚主动发给 TA 的消息（TA 接下来很可能在回应这条）\n\n" + _proactive_lead)

    from agent.context import compress_conv
    _summary, history = compress_conv.pop_summary(history)

    # 动态上下文注入消息：用 [system-reminder] 包裹，LLM 理解为系统上下文而非对话内容
    _ctx_injection = None
    if _dynamic_extra_parts:
        _ctx_content = "\n\n".join(_dynamic_extra_parts)
        _ctx_injection = session_snapshot.reminder_message(_ctx_content)

    from agent.llm.llm_select import use_anthropic_for
    use_anthropic = use_anthropic_for(model_cfg)
    tool_names = filter_tool_names(profile.tool_names, req.allowed_tool_names)
    runner = LLMRunner(tool_names, settings)
    # 即使 LLM 在首轮失败，响应也要能安全走完错误收尾路径。
    im_used_tools = False

    from app.core.chat_attach import build_user_content
    from agent.im.context_loader import format_current_content, format_history_content
    from agent.context.tokens import content_text
    current_llm_text = format_current_content(aug_text, req)
    anthr_messages: list = []
    anthr_initial_len = 0
    fixed_parts = ([_ctx_injection] if _ctx_injection else [])
    if _summary:
        fixed_parts.append({"role": "user", "content": compress_conv.system_block(_summary)})
    history_parts = [{"role": h.role, "content": h.content_json if h.content_json is not None else format_history_content(h, req)} for h in history]
    tail_parts = [message_assembly.reminder(part) for part in dynamic_tail]
    tail_parts.append(session_snapshot.reminder_message(f"当前时间：{now_str}"))
    if use_anthropic:
        assembly = message_assembly.build_messages(
            fixed_parts=fixed_parts, history=history_parts,
            current_user={"role": "user", "content": build_user_content(current_llm_text, aug_images, True, media=aug_media)},
            dynamic_tail=tail_parts,
        )
        # 清洗：去孤儿 tool_use/tool_result、空块、块里的 None 字段（MiniMax 严格校验，否则
        # 历史里带非标字段/不配对工具块会报 `text is not set` 等）。**IM 路此前漏了这步，web 路一直有**。
        clean_conversation = sanitize.sanitize_messages(assembly.conversation)
        assembly.replace_conversation(clean_conversation)
        anthr_messages = assembly
        anthr_initial_len = len(assembly.conversation)
        gen = runner.run(user_id, system_prompt, anthr_messages, use_anthropic=True,
                         model_cfg=model_cfg, session_id=session_id)
    else:
        oa_messages = message_assembly.build_messages(
            fixed_parts=[{"role": "system", "content": system_prompt}] + fixed_parts,
            history=history_parts,
            current_user={"role": "user", "content": build_user_content(current_llm_text, aug_images, False, media=aug_media)},
            dynamic_tail=tail_parts,
        )
        gen = runner.run(user_id, None, oa_messages, use_anthropic=False,
                         model_cfg=model_cfg, session_id=session_id)

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
                for tm in sanitize.tool_rounds_only(message_assembly.newly_appended(anthr_messages, anthr_initial_len)):
                    db2.add(ConversationMessage(
                        session_id=session_id, role=tm["role"],
                        content="", content_json=chat_attach.strip_vision_for_history(tm["content"]),
                    ))
            if text or sent_files:
                db2.add(ConversationMessage(session_id=session_id, role="assistant",
                                            content=text, files=sent_files or None))
            # 按 6h 剩余额度封顶本轮用量（精力条最多 100%，顶过线只记填满部分，超出不计 6h 与周）；已满则 (0,0) 不写
            snapshot_session = await db2.get(ConversationSession, session_id)
            if snapshot_session is not None:
                await db2.flush()
                latest_message_id = await db2.scalar(
                    select(func.max(ConversationMessage.id)).where(
                        ConversationMessage.session_id == session_id
                    )
                )
                session_snapshot.checkpoint_snapshot(
                    snapshot_session,
                    [{"role": "user", "content": req.message},
                     {"role": "assistant", "content": text}],
                    message_id=latest_message_id,
                    run_id=snapshot_session.snapshot_last_run_id,
                )
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
        if profile.memory_enabled and text and context_policy.allow_memory_reflection:
            from agent.memory import reflection
            im_used_tools = use_anthropic and len(anthr_messages) > anthr_initial_len
            reflect_message, reflect_reply = _reflection_input(
                req, anthr_messages, anthr_initial_len, text
            )
            if reflect_reply:
                reflection.schedule(user_id, req.user_name, reflect_message, reflect_reply, settings,
                                    used_tools=im_used_tools, session_id=session_id,
                                    group_mode=bool(req.chat_id and req.source != "web"))

# 对话压缩（fire-and-forget）
    from agent.context import compress_conv
    compress_conv.schedule(session_id, user_id, settings, model_cfg.context_tokens)

    return AgentResponse(text=text, session_id=session_id, tokens_in=tin, tokens_out=tout,
                         files=sent_files, used_tools=im_used_tools)


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
    context_policy = policy_for(req)
    restricted_im = context_policy.restricted

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import (
        AgentUsage, ConversationMessage, ConversationSession,
    )

    async with _sess._SessionLocal() as db:
        session_state = await get_or_create_session(db, req, user_id)
        session, is_new_session = session_state.session, session_state.is_new
        session_id = session.id

        async def _load_snapshot():
            data = await load_context_data(
                db, user_id, req, profile.memory_enabled, req.message, context_policy
            )
            static_prompt, dynamic_context, _ = builder.build_split(
                profile.prompt_file.removesuffix(".md"), req.user_name,
                data.projects, data.events, data.memory, data.files_overview,
                skills=profile.skills, style_prefs=data.style_prefs,
                source=getattr(req, "source", None), im_channels=data.im_channels,
                im_message_format=getattr(req, "im_message_format", None),
                user_msg=req.message, non_streaming=False, user_tz=data.user_tz,
            )
            return {"system_prompt": static_prompt, "dynamic_context": dynamic_context,
                    "session_info": {"user_name": req.user_name, "source": req.source,
                                      "chat_id": req.chat_id, "profile": profile.prompt_file},
                    "user_tz": data.user_tz, "im_channels": data.im_channels,
                    "im_memory": data.im_memory,
                    "dynamic_tail": builder.dynamic_tail(data.memory)}

        snapshot = await session_snapshot.ensure_snapshot(db, session, load_context=_load_snapshot)
        user_tz = snapshot["user_tz"]
        set_ctx_tz(user_tz)
        context_data = SimpleNamespace(im_memory=snapshot["im_memory"])

        # 历史窗口
        hist_res = await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == session_id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(_history_query_limit(req))
        )
        history = tokens.select_history(hist_res.scalars().all(), token_budget=model_cfg.context_tokens)
        _nonsumm = [h for h in history if getattr(h, "role", None) != "summary"]
        _proactive_lead = _nonsumm[0].content if _nonsumm and _nonsumm[0].role == "assistant" else ""

        from app.core import chat_attach
        llm_text = _with_quoted_context(req.message, getattr(req, "quoted_text", None))
        aug_text, attach_cards, aug_images, aug_media = await chat_attach.resolve_for_message(
            user_id, getattr(req, "attachments", None) or [], llm_text, model_cfg=model_cfg)
        user_message = ConversationMessage(session_id=session_id, role="user", content=req.message,
                                           files=attach_cards or None, quoted_text=getattr(req, "quoted_text", None),
                                           platform_user_id=req.platform_user_id,
                                           platform_user_name=req.platform_user_name,
                                           platform_bot_user_id=req.platform_bot_user_id,
                                           chat_type="group" if req.chat_id else "c2c" if req.source in IM_SOURCES else None)
        db.add(user_message)
        await db.flush()
        try:
            await chat_attach.claim_attachments(
                db, user_id, user_message.id, [c["attach_id"] for c in (attach_cards or [])])
        except chat_attach.AttachmentClaimError:
            await db.rollback()
            yield ("final", AgentResponse(text="附件已失效（可能已被使用或清理），请重新发送", session_id=session_id,
                                          tokens_in=0, tokens_out=0))
            return
        await db.commit()

        if await quota.is_exhausted(db, user_id, settings):
            yield ("final", AgentResponse(text="咕咕累了，休息会儿再来～", session_id=session_id,
                                          tokens_in=0, tokens_out=0))
            return

        im_bridge = ""
        if is_new_session and context_policy.allow_continuity_bridge:
            try:
                im_bridge = await _im_continuity_bridge(
                    db,
                    user_id,
                    session_id,
                    req.message,
                    req.source,
                    req.chat_id,
                    req.platform_bot_id,
                    req.platform_user_id,
                )
            except Exception:
                im_bridge = ""

    # 用户消息先推给网页（跟 run_collect 一致）。带上发起标签页的 origin：本标签页已经在
    # send() 里乐观 push 过这条用户消息，靠它跳过这条广播自己的回声，只让别的标签页/端刷新。
    try:
        from app.core import events as _evmod
        await _evmod.publish(user_id, "sessions", session_id=session_id, origin=getattr(req, "origin", None),
                             appended=[{"role": "user", "text": req.message, "files": attach_cards or None,
                                       "quoted_text": getattr(req, "quoted_text", None),
                                       "platform_user_id": req.platform_user_id,
                                       "platform_user_name": req.platform_user_name}])
    except Exception:
        pass

    # 语音转写（跟 run_collect 一致）：不支持时直接结束
    _transcribe_media = [m for m in aug_media if m.get("type") != "video"]
    if _transcribe_media:
        from agent import voice as _voice
        transcript = await _voice.transcribe(_transcribe_media, settings)
        if transcript is None:
            _release_model(model_cfg)
            yield ("final", AgentResponse(
                text="抱歉，我现在还不能处理语音 / 音视频消息哦，打字告诉我就行～",
                session_id=session_id, tokens_in=0, tokens_out=0))
            return
        spoken = transcript.strip() or "（用户发来一段语音，但这次没听清内容）"
        aug_text = (aug_text + "\n" if aug_text else "") + f"（用户发来语音，内容是：）{spoken}"
        aug_media = [m for m in aug_media if m.get("type") == "video"]

    system_prompt = snapshot["system_prompt"]
    dynamic_context = snapshot["dynamic_context"]
    now_str = session_snapshot.current_time_text(user_tz)
    dynamic_tail = builder.dynamic_tail(
        await loaders.load_dynamic_memory(user_id) if profile.memory_enabled else {}
    )

    # 组装动态上下文注入块（放入 messages，不进 system）
    _dynamic_extra_parts = []
    if dynamic_context:
        _dynamic_extra_parts.append(dynamic_context)
    _im_id = _im_identity_block(req, history)
    if _im_id:
        _dynamic_extra_parts.append(_im_id)
    if context_data.im_memory:
        from agent.im.context_loader import format_im_memory
        scope_memory = format_im_memory(context_data.im_memory, req.im_role)
        if scope_memory:
            _dynamic_extra_parts.append(scope_memory)
    if im_bridge:
        _dynamic_extra_parts.append(im_bridge)
    if _proactive_lead:
        _dynamic_extra_parts.append("\n## 你刚主动发给 TA 的消息（TA 接下来很可能在回应这条）\n\n" + _proactive_lead)

    from agent.context import compress_conv
    _summary, history = compress_conv.pop_summary(history)

    # 动态上下文注入消息：用 [system-reminder] 包裹，LLM 理解为系统上下文而非对话内容
    _ctx_injection = None
    if _dynamic_extra_parts:
        _ctx_content = "\n\n".join(_dynamic_extra_parts)
        _ctx_injection = session_snapshot.reminder_message(_ctx_content)

    from agent.llm.llm_select import use_anthropic_for
    use_anthropic = use_anthropic_for(model_cfg)
    tool_names = filter_tool_names(profile.tool_names, req.allowed_tool_names)
    runner = LLMRunner(tool_names, settings)
    # 流式 IM 失败时也会产出统一的 AgentResponse，不能依赖成功分支初始化。
    im_used_tools = False

    from app.core.chat_attach import build_user_content
    from agent.im.context_loader import format_current_content, format_history_content
    current_llm_text = format_current_content(aug_text, req)
    anthr_messages: list = []
    anthr_initial_len = 0
    fixed_parts = ([_ctx_injection] if _ctx_injection else [])
    if _summary:
        fixed_parts.append({"role": "user", "content": compress_conv.system_block(_summary)})
    history_parts = []
    if use_anthropic:
        for h in history:
            # 正确处理 content_json（可能是 list 或 string）
            if h.content_json is not None:
                content = content_text(h.content_json)
            else:
                content = format_history_content(h, req)
            history_parts.append({"role": h.role, "content": content})
        tail_parts = [message_assembly.reminder(part) for part in dynamic_tail]
        tail_parts.append(session_snapshot.reminder_message(f"当前时间：{now_str}"))
        assembly = message_assembly.build_messages(
            fixed_parts=fixed_parts, history=history_parts,
            current_user={"role": "user", "content": build_user_content(current_llm_text, aug_images, True, media=aug_media)},
            dynamic_tail=tail_parts)
        assembly.replace_conversation(sanitize.sanitize_messages(assembly.conversation))
        anthr_messages = assembly
        anthr_initial_len = len(assembly.conversation)
        gen = runner.run(user_id, system_prompt, anthr_messages, use_anthropic=True,
                         model_cfg=model_cfg, session_id=session_id)
    else:
        history_parts = [{"role": h.role, "content": format_history_content(h, req)} for h in history]
        tail_parts = [message_assembly.reminder(part) for part in dynamic_tail]
        tail_parts.append(session_snapshot.reminder_message(f"当前时间：{now_str}"))
        oa_messages = message_assembly.build_messages(
            fixed_parts=[{"role": "system", "content": system_prompt}] + fixed_parts,
            history=history_parts,
            current_user={"role": "user", "content": build_user_content(current_llm_text, aug_images, False, media=aug_media)},
            dynamic_tail=tail_parts)
        gen = runner.run(user_id, None, oa_messages, use_anthropic=False,
                         model_cfg=model_cfg, session_id=session_id)


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
                for tm in sanitize.tool_rounds_only(message_assembly.newly_appended(anthr_messages, anthr_initial_len)):
                    db2.add(ConversationMessage(
                        session_id=session_id, role=tm["role"],
                        content="", content_json=chat_attach.strip_vision_for_history(tm["content"]),
                    ))
            if text or files:
                db2.add(ConversationMessage(session_id=session_id, role="assistant",
                                            content=text, files=files or None))
            snapshot_session = await db2.get(ConversationSession, session_id)
            if snapshot_session is not None:
                await db2.flush()
                latest_message_id = await db2.scalar(
                    select(func.max(ConversationMessage.id)).where(
                        ConversationMessage.session_id == session_id
                    )
                )
                session_snapshot.checkpoint_snapshot(
                    snapshot_session,
                    [{"role": "user", "content": req.message},
                     {"role": "assistant", "content": text}],
                    message_id=latest_message_id,
                    run_id=snapshot_session.snapshot_last_run_id,
                )
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
                # 本标签页的流式 token 已经把这段文字画进气泡了，带 origin 让它跳过这条广播，
                # 只让别的标签页/端补上；分段发送（一轮里多条 assistant 消息）同理靠 origin 抑制。
                await _evmod.publish(user_id, "sessions", session_id=session_id, origin=getattr(req, "origin", None),
                                     appended=[{"role": "assistant", "text": text, "files": files or None}])
            else:
                await _evmod.publish(user_id, "sessions", session_id=session_id, origin=getattr(req, "origin", None))
        except Exception:
            pass

        if profile.memory_enabled and text and context_policy.allow_memory_reflection:
            from agent.memory import reflection
            im_used_tools = use_anthropic and len(anthr_messages) > anthr_initial_len
            reflect_message, reflect_reply = _reflection_input(
                req, anthr_messages, anthr_initial_len, text
            )
            if reflect_reply:
                reflection.schedule(user_id, req.user_name, reflect_message, reflect_reply, settings,
                                    used_tools=im_used_tools, session_id=session_id,
                                    group_mode=bool(req.chat_id and req.source != "web"))

        from agent.context import compress_conv as _cc
        _cc.schedule(session_id, user_id, settings, model_cfg.context_tokens)

    yield ("final", AgentResponse(text=text, session_id=session_id, tokens_in=tin,
                                  tokens_out=tout, files=files, cancelled=False,
                                  used_tools=im_used_tools))


async def _collect(
    gen: AsyncGenerator[str, None], minimax: bool = False, include_meta: bool = False,
) -> Tuple:
    """消费 LLMRunner 的 SSE 流：清洗后攒文本 + 取用量 + 收集咕咕要发的文件。
    返回 (文本, in, out, errored, files)；errored=True 时文本是错误文案（不入历史/不反思）。

    文本**按轮分段收集，只取最后一轮**：这条路径（run_collect/定时任务）不流式展示给
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
    tool_names: list[str] = []
    mutated = False
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
        elif t == "tool_call":
            name = str(evt.get("name") or "")
            if name and name not in tool_names:
                tool_names.append(name)
            # 按工具注册时显式声明的 mutates 判断，不再靠名字前缀猜——猜测式前缀匹配
            # 会漏掉 remember（写长期记忆）、undo_last_gugu_note（删笔记）这类不落在
            # create_/update_/delete_/... 词表里的写工具，导致失败后重跑整轮时
            # 重复执行已经生效的写操作。
            from agent.tools import registry as _tool_registry
            tool = _tool_registry.get(name)
            if tool is not None and tool.mutates:
                mutated = True
        elif t == "_cancelled":
            cancelled = True   # 用户中途「算了」：停止收集，网关已回「先不继续」，worker 不再补发
            break
        elif t == "error":
            detail = evt.get("message") or evt.get("detail") or "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
            result = (detail, tin, tout, True, files, False)
            return result + ({"tool_names": tool_names, "mutated": mutated},) if include_meta else result
    cur += san.flush()
    rounds.append(cur)

    text = ""
    for r in reversed(rounds):
        r = r.strip()
        if r:
            text = r
            break
    # Web 流式出口已有同样的清洗；IM collect 也必须过滤模型偶尔复述的
    # 内部消息时间，否则 QQ/群聊会把 [消息时间：...] 直接发给用户。
    time_san = sanitize.LeadingMessageTimeSanitizer()
    text = time_san.feed(text) + time_san.flush()
    result = (text, tin, tout, False, files, cancelled)
    return result + ({"tool_names": tool_names, "mutated": mutated},) if include_meta else result


async def _run_scheduled_once(
    user_id,
    user_name: str,
    prompt: str,
    profile,
    settings,
    *,
    include_meta: bool = False,
    tool_names_override: list[str] | None = None,
    minimal_context: bool = False,
):
    """执行一个非流式阶段；编排、重试和投递由 app.scheduled_tasks 负责。"""
    model_cfg = pick_model(settings, None)
    try:
        import app.db.session as _sess

        if _sess._engine is None:
            _sess._build_engine()

        async with _sess._SessionLocal() as db:
            user_tz = await loaders.load_user_tz(db, user_id)
            set_ctx_tz(user_tz)
            if minimal_context:
                projects, events, files_overview, memory, im_channels = [], [], None, {}, []
            else:
                projects = await loaders.load_projects(db, user_id)
                events = await loaders.load_events(db, user_id, tz=user_tz)
                files_overview = await loaders.load_files_overview(db, user_id)
                memory = await loaders.load_memory(user_id) if profile.memory_enabled else {}
                im_channels = await loaders.load_im_channels(user_id)

        prompt_name = profile.prompt_file.removesuffix(".md")
        static_prompt, dynamic_context, now_str = builder.build_split(
            prompt_name,
            user_name,
            projects,
            events,
            memory,
            files_overview,
            skills=profile.skills,
            im_channels=im_channels,
            non_streaming=True,
            include_projects=not minimal_context,
            include_calendar=not minimal_context,
            include_files=not minimal_context,
            include_memory=not minimal_context,
            user_tz=user_tz,
        )
        system_prompt = static_prompt

        from agent.llm.llm_select import use_anthropic_for

        use_anthropic = use_anthropic_for(model_cfg)
        tool_names = (
            tool_names_override
            if tool_names_override is not None
            else profile.tool_names
        )
        runner = LLMRunner(tool_names, settings)

        from app.core.chat_attach import build_user_content

        if use_anthropic:
            messages = _build_scheduled_messages(
                system_prompt, dynamic_context, now_str, prompt, memory,
                use_anthropic=True, user_content=build_user_content(prompt, [], True),
            )
            gen = runner.run(
                user_id,
                system_prompt,
                messages,
                use_anthropic=True,
                model_cfg=model_cfg,
            )
        else:
            messages = _build_scheduled_messages(
                system_prompt, dynamic_context, now_str, prompt, memory,
                use_anthropic=False, user_content=prompt,
            )
            gen = runner.run(
                user_id,
                None,
                messages,
                use_anthropic=False,
                model_cfg=model_cfg,
            )

        collected = await _collect(
            gen,
            minimax=is_minimax(model_cfg),
            include_meta=include_meta,
        )
        text, _, _, errored, files, _, *meta = collected
        return (
            (text, errored, {**(meta[0] if meta else {}), "files": files})
            if include_meta
            else (text, errored)
        )
    finally:
        _release_model(model_cfg)


def _build_scheduled_messages(system_prompt: str, dynamic_context: str,
                              now_str: str, prompt: str, memory: dict,
                              *, use_anthropic: bool, user_content=None):
    """scheduled 与 Web/IM 使用同样的动态上下文布局。"""
    fixed_parts = ([session_snapshot.reminder_message(dynamic_context)]
                   if dynamic_context else [])
    dynamic_tail = [message_assembly.reminder(part)
                    for part in builder.dynamic_tail(memory)]
    dynamic_tail.append(session_snapshot.reminder_message(f"当前时间：{now_str}"))
    if user_content is None:
        user_content = prompt
    if use_anthropic:
        return message_assembly.build_messages(
            fixed_parts=fixed_parts, history=[],
            current_user={"role": "user", "content": user_content},
            dynamic_tail=dynamic_tail,
        )
    return message_assembly.build_messages(
        fixed_parts=[{"role": "system", "content": system_prompt}] + fixed_parts,
        history=[], current_user={"role": "user", "content": user_content},
        dynamic_tail=dynamic_tail,
    )


async def run_scheduled_execution(user_id, user_name: str, prompt: str):
    """执行阶段适配器，始终使用完整 AgentLoop 上下文和工具集。"""
    return await _run_scheduled_once(
        user_id,
        user_name,
        prompt,
        DefaultProfile(),
        get_settings(),
        include_meta=True,
    )
