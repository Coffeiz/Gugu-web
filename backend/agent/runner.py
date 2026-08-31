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

from sqlalchemy import select

from app.core.config import get_settings
from agent.security import sanitize
from agent import quota
from agent.context import builder, loaders, tokens, session_snapshot, assembly, session_history, audit, run_context
from agent.core import LLMRunner
from agent.im.context_policy import IM_SOURCES, policy_for
from agent.im.context_loader import load_context_data, load_platform_user_memory
from agent.im.permissions import filter_tool_names
from agent.im.session import (
    GROUP_CONTEXT_LIMIT,
    get_or_create_session,
    session_scope_filters,
)
from agent.llm.llm_select import resolve_run_config, resolve_run_config_for_user, release as _release_model
from agent.models import AgentRequest, AgentResponse
from agent.profiles import DefaultProfile

# 后台任务引用，防止被 GC（fire-and-forget 的标题生成等）
_bg_tasks: set = set()


def _canonical_tool_batch_records(messages) -> list[dict]:
    """只取已封存的工具批次；动态尾缀和普通控制提示不进入 canonical history。"""
    records = getattr(messages, "canonical_batch_records", ())
    return [record for record in records
            if isinstance(record, dict)
            and (record.get("metadata") or {}).get("round_id")]


async def _capability_context(tool_names, settings, *, db=None, owner_id=None, query=""):
    """创建固定 Adapter 能力上下文。业务工具不再回退到全量原生 Schema。"""
    from agent.capabilities.injector import build_fixed_adapter_context, build_fixed_adapter_context_for_user
    async def _full_schema_preference(session):
        if owner_id is None:
            return False
        from app.models import UserPreferences
        from sqlalchemy import select
        row = await session.scalar(select(UserPreferences).where(UserPreferences.user_id == owner_id))
        stored_mode = (row.data or {}).get("tool_injection_mode") if row else None
        if stored_mode is None:
            return False
        return stored_mode in {"full", "compact_schema", "full_schema"}

    if db is None and owner_id is not None:
        import app.db.session as _sess
        if _sess._engine is None:
            _sess._build_engine()
        async with _sess._SessionLocal() as capability_db:
            if await _full_schema_preference(capability_db):
                return None
            context = await build_fixed_adapter_context_for_user(
                tool_names, db=capability_db, owner_id=owner_id, search_settings=settings,
            )
            if query:
                await context.select_for_query(query)
            return context
    if db is not None and owner_id is not None:
        if await _full_schema_preference(db):
            return None
        context = await build_fixed_adapter_context_for_user(
            tool_names, db=db, owner_id=owner_id, search_settings=settings,
        )
        if query:
            await context.select_for_query(query)
        return context
    context = build_fixed_adapter_context(tool_names, search_settings=settings, owner_id=owner_id)
    if query:
        await context.select_for_query(query)
    return context


async def _filter_shell_tool(db, user_id, session_id: int | None, names: list[str], *, session=None) -> list[str]:
    """工具注册前过滤 Shell；执行器仍会再次调用策略层复核。"""
    if "shell" not in names:
        return names
    from agent.security.shell_policy import available_for_session
    if await available_for_session(db, user_id, session_id, session=session):
        return names
    return [name for name in names if name != "shell"]


def _im_identity_block(req: AgentRequest, history: list) -> str:
    """把 IM 身份元数据作为内部事实提供给模型，禁止模型凭熟悉感猜身份。"""
    if req.source not in IM_SOURCES or not req.chat_id:
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
                from agent.context.audit import session_scope, summary_change
                audit_scope = session_scope(s)
                audit_scope.pop("source", None)
                summary_change(
                    source="conversation_session_summary_bg",
                    old=s.summary,
                    new=summary,
                    trigger="force" if force else "periodic",
                    **audit_scope,
                )
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
    from agent.im.context_loader import format_quoted_context

    return format_quoted_context(message, quoted_text)


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


async def _run_collect_unlocked(
    req: AgentRequest, *, on_interaction=None, on_tool_event=None, on_round=None
) -> AgentResponse:
    """找/建会话 + 读历史 → 跑工具循环 → 攒完整回复 + 存盘 + 反思。"""
    user_id = req.user_id
    profile = DefaultProfile()
    settings = get_settings()
    run_config = resolve_run_config(settings, req)
    model_cfg = run_config.model
    context_policy = policy_for(req)
    restricted_im = context_policy.restricted
    # 不强切 vision 模型：这轮 pick 到的模型看得了图就识图、看不了就当普通文件存（下面 resolve
    # 按 model_cfg 判 vision）。避免硬切到「标了 vision 实则不收图片块」的模型（如 MiniMax 兼容口）。

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import ConversationMessage, ConversationSession

    async with _sess._SessionLocal() as db:
        run_config = await resolve_run_config_for_user(settings, db, user_id, req)
        model_cfg = run_config.model
        session_state = await get_or_create_session(db, req, user_id)
        session, is_new_session = session_state.session, session_state.is_new
        session_id = session.id
        from app.services.workspaces import resolve_workspace_target
        workspace_target = await resolve_workspace_target(
            db, user_id, session.workspace_id,
        ) if session.workspace_id is not None else None

        async def _load_snapshot():
            data = await load_context_data(
                db, user_id, req, profile.memory_enabled, req.message, context_policy
            )
            static_prompt, snapshot_context, _ = builder.build_split(
                profile.prompt_file.removesuffix(".md"), req.user_name,
                data.projects, data.events, data.memory, data.files_overview,
                notes=data.notes,
                skills=profile.skills, style_prefs=data.style_prefs,
                source=getattr(req, "source", None), im_channels=data.im_channels,
                im_message_format=getattr(req, "im_message_format", None),
                user_msg=req.message, non_streaming=True, user_tz=data.user_tz,
            )
            from agent.im.context_loader import format_group_memory, format_platform_user_memory
            group_memory = (data.im_memory or {}).get("group") or {}
            group_block = format_group_memory({"group": group_memory})
            if group_block:
                snapshot_context = f"{snapshot_context}\n\n---\n\n{group_block}"
            # 私聊 member 只把当前平台用户的稳定记忆放进 snapshot；不注入 daily
            # 或 owner 记忆。群聊仍只走上面的群公开记忆分支。
            private_member_memory = {}
            if not req.chat_id and context_policy.restricted:
                private_member_memory = (data.im_memory or {}).get("platform_user") or {}
                member_block = format_platform_user_memory(
                    {"platform_user": private_member_memory}
                )
                if member_block:
                    snapshot_context = f"{snapshot_context}\n\n---\n\n{member_block}"
            return {
                "system_prompt": static_prompt,
                "snapshot_context": snapshot_context,
                "session_info": {"user_name": req.user_name, "source": req.source,
                                  "chat_id": req.chat_id, "profile": profile.prompt_file},
                "user_tz": data.user_tz,
                "im_channels": data.im_channels,
                # 共享 snapshot 只保存当前群公开记忆；成员个人记忆按请求动态读取。
                "im_memory": ({"group": group_memory}
                              if req.chat_id else
                              {"platform_user": private_member_memory}),
                "memory_summary_hash": session_snapshot.memory_summary_hash(data.memory),
            }

        snapshot = await session_snapshot.ensure_snapshot(db, session, load_context=_load_snapshot)
        user_tz = snapshot["user_tz"]
        set_ctx_tz(user_tz)
        # 兼容旧 snapshot：旧版本把群记忆放在动态尾部，命中旧快照时恢复到正文。
        from agent.im.context_loader import restore_group_memory_snapshot
        restore_group_memory_snapshot(snapshot)
        member_memory = await load_platform_user_memory(req)
        context_data = SimpleNamespace(im_memory={
            "group": (snapshot.get("im_memory") or {}).get("group") or {},
            "platform_user": member_memory,
        })

        # 历史读取不做本地 token 预估；预算由 provider 实际请求结果决定。
        history = await session_history.load_session_history(
            db,
            session_id,
            session_snapshot.history_baseline(session),
        )
        history_stats = session_history.consume_history_stats()
        from agent.context.provider_history import clean_persisted_history, prepare_session
        _, strip_thinking = prepare_session(session, model_cfg)
        if strip_thinking:
            clean_persisted_history(history)
            strip_thinking = False
        # 主动推送（定时任务/活动提醒）若是会话首条 assistant（前导，sanitize 会剥掉）→ 记下来塞进 system，
        # 让咕咕知道「自己刚主动发了啥」、能接住用户对它的回复（如新闻速览后用户回「4」）。
        # 主动推送桥只保留群聊行为；私聊不把历史首条主动消息重复塞进每轮尾部。
        _proactive_lead = ""
        if req.chat_id:
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

    # 主模型支持音频时直接保留音频块；否则才用独立配置的「语音识别模型」
    # 转成文字交给主模型。两者都不可用时，resolve_for_message 已留下不支持提示。
    _transcribe_media = [m for m in aug_media if m.get("type") != "video"]
    if _transcribe_media and chat_attach.should_transcribe_audio(model_cfg):
        from agent import voice as _voice
        # 前面的会话读取事务已经结束，不能继续复用已退出上下文的 db；
        # 语音模型解析需要独立短事务，避免把连接带进后续 LLM 等待。
        async with _sess._SessionLocal() as voice_db:
            transcript = await _voice.transcribe(
                _transcribe_media, settings, db=voice_db, user_id=user_id,
            )
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
    snapshot_context = snapshot["snapshot_context"]
    stance_text = builder.stance_block(
        await loaders.load_dynamic_memory(user_id) if profile.memory_enabled else {}
    )

    # snapshot 内容在 snapshot 有效期内保持稳定，放在 history 之前形成可缓存前缀。
    _snapshot_injection = (
        session_snapshot.snapshot_message(snapshot_context)
        if snapshot_context else None
    )

    # 组装本轮动态上下文注入块（放入 history 之后，不进 system）
    _dynamic_extra_parts = []
    _im_id = _im_identity_block(req, history)
    if _im_id:
        _dynamic_extra_parts.append(_im_id)
    if im_bridge:
        _dynamic_extra_parts.append(im_bridge)
    if _proactive_lead:
        _dynamic_extra_parts.append("\n## 你刚主动发给 TA 的消息（TA 接下来很可能在回应这条）\n\n" + _proactive_lead)
    if workspace_target:
        _workspace_name = workspace_target.get("workspace_name") or "当前工作区"
        _dynamic_extra_parts.append(
            "## 当前会话工作区（文件工具必须遵守）\n"
            f"当前绑定：{_workspace_name}；"
            f"规范落点 space={workspace_target['space']}, "
            f"project_id={workspace_target.get('project_id')}, "
            f"folder_id={workspace_target.get('folder_id')}。\n"
            "workspace_id 与 project_id/folder_id 不同命名空间；创建、保存、移动、复制、"
            "按名称查找文件时，省略目标参数即使用上述落点，不要把 workspace_id 当作 project_id。"
        )

    from agent.context import compress_conv

    # 本轮动态上下文用 [system-reminder] 包裹，避免和 snapshot 固定前缀混淆。
    _ctx_injection = None
    if _dynamic_extra_parts:
        _ctx_content = "\n\n".join(_dynamic_extra_parts)
        _ctx_injection = session_snapshot.reminder_message(_ctx_content)

    use_anthropic = run_config.use_anthropic
    tool_names = filter_tool_names(profile.tool_names, req.allowed_tool_names)
    # 这里同样使用短事务。工具组装可能触发数据库查询，不能把前面已关闭的
    # session 传入，否则 AsyncSession 会在上下文外重新 checkout 连接并由 GC 回收。
    async with _sess._SessionLocal() as tool_db:
        tool_names = await _filter_shell_tool(
            tool_db, user_id, session_id, tool_names, session=session,
        )
        capability_context = await _capability_context(
            tool_names, settings, db=tool_db, owner_id=user_id, query=aug_text,
        )
    if capability_context is not None:
        from agent.capabilities.injector import catalog_block
        _snapshot_injection = session_snapshot.snapshot_message(
            f"{snapshot_context}\n\n{catalog_block(capability_context.snapshot, tool_order=capability_context.selection.tool_names)}"
        )
    runner = LLMRunner(tool_names, settings, capability_context=capability_context)
    # 即使 LLM 在首轮失败，响应也要能安全走完错误收尾路径。
    im_used_tools = False

    from agent.im.context_loader import format_current_content
    current_llm_text = format_current_content(aug_text, req)
    prepared = await run_context.prepare_run(
        system_prompt=system_prompt,
        snapshot_context=snapshot_context,
        history=history,
        req=req,
        user_tz=user_tz,
        strip_thinking=strip_thinking,
        use_anthropic=use_anthropic,
        current_text=current_llm_text,
        images=aug_images,
        media=aug_media,
        model_cfg=model_cfg,
        stance_text=stance_text,
        snapshot_injection=_snapshot_injection,
        extra_reminder="\n\n".join(_dynamic_extra_parts) if _dynamic_extra_parts else None,
        user_message=user_message,
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
        on_interaction=on_interaction,
    )

    try:
        text, tin, tout, cache_read, cache_write, errored, sent_files, cancelled, meta = await _collect(
            gen, model_cfg=model_cfg, include_meta=True, on_tool_event=on_tool_event,
            on_round=on_round)
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
        round_texts = []
        for round_text in meta.get("round_texts") or []:
            cleaned = sanitize_outbound(round_text)
            cleaned = sanitize.strip_disallowed_emoji(cleaned)
            if cleaned.strip():
                round_texts.append(cleaned)
        meta["round_texts"] = round_texts

    # IM/非流式生成也要保存逐轮展示时间线。canonical assistant.content 兼容旧历史，
    # 但刷新回放必须依赖 display_timeline，否则多轮输出只剩最后一轮。
    display_timeline = [
        {"kind": "assistant", "text": round_text}
        for round_text in (meta.get("round_texts") or [])
        if str(round_text or "").strip()
    ]

    # ── 持久化：工具调用轮次（anthropic）+ 回复 + 用量（报错不入历史）──
    if not errored:
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
            text=text,
            display_timeline=display_timeline or None,
            files=sent_files,
            tokens_in=tin,
            tokens_out=tout,
            cache_read=cache_read,
            cache_write=cache_write,
            context_tokens=run_config.context_tokens,
            actual_usage_tokens=int(meta.get("context_input", tin) or 0),
            compaction_applied=bool(meta.get("compaction_applied", False)),
        )

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
            assistant_rounds = [
                {"role": "assistant", "text": round_text}
                for round_text in (meta.get("round_texts") or [])
                if str(round_text or "").strip()
            ]
            if not assistant_rounds and text:
                assistant_rounds = [{"role": "assistant", "text": text}]
            if assistant_rounds or sent_files:
                appended = [
                    {**item, "files": sent_files or None}
                    if index == len(assistant_rounds) - 1 else item
                    for index, item in enumerate(assistant_rounds)
                ]
                if not appended:
                    appended = [{"role": "assistant", "text": "", "files": sent_files or None}]
                await _evmod.publish(user_id, "sessions", session_id=session_id,
                                     appended=appended)
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

    return AgentResponse(text=text, round_texts=list(meta.get("round_texts") or []), session_id=session_id, tokens_in=tin, tokens_out=tout,
                         cache_read=cache_read, cache_write=cache_write,
                         files=sent_files, used_tools=im_used_tools,
                         interactions=meta.get("interactions", []),
                         tool_events=meta.get("tool_events", []),
                         compaction_applied=bool(meta.get("compaction_applied", False)))


async def run_collect(
    req: AgentRequest, *, on_interaction=None, on_tool_event=None, on_round=None
) -> AgentResponse:
    """同一 session 串行生成；不同 session 仍可并行。"""
    from agent.context import compress_conv

    async with compress_conv.session_run_gate(req):
        response = await _run_collect_unlocked(
            req, on_interaction=on_interaction, on_tool_event=on_tool_event,
            on_round=on_round,
        )
        # baseline 是 run 末尾提交的安全点。释放 gate 前必须等待它完成，
        # 否则下一个 worker 可能在 summary/baseline 提交前读取旧快照并再次压缩。
        await compress_conv.wait_for_baseline_update(response.session_id or req.session_id)
        return response


async def _notify_tool_event(callback, event: dict) -> None:
    """通知 IM 工具状态展示；展示失败只写受限诊断，不影响 Agent 执行。"""
    if callback is None:
        return
    try:
        await callback(event)
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("agent.im.tool_event_display", exc)


async def _notify_round(callback, text: str) -> bool:
    """通知 IM 展示已完成的正文 round；展示失败不影响 Agent 执行。"""
    if callback is None:
        return False
    try:
        result = await callback(text)
        return result is not False
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("agent.im.round_display", exc)
        return False


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
async def _run_stream_unlocked(
    req: AgentRequest,
    *,
    on_interaction=None,
    on_tool_event=None,
) -> AsyncIterator[tuple[str, object]]:
    """run_collect 的流式版本：逐字 yield token + 末尾 yield AgentResponse。"""
    user_id = req.user_id
    profile = DefaultProfile()
    settings = get_settings()
    run_config = resolve_run_config(settings, req)
    model_cfg = run_config.model
    context_policy = policy_for(req)
    restricted_im = context_policy.restricted

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import ConversationMessage, ConversationSession

    async with _sess._SessionLocal() as db:
        run_config = await resolve_run_config_for_user(settings, db, user_id, req)
        model_cfg = run_config.model
        session_state = await get_or_create_session(db, req, user_id)
        session, is_new_session = session_state.session, session_state.is_new
        session_id = session.id
        from app.services.workspaces import resolve_workspace_target
        workspace_target = await resolve_workspace_target(
            db, user_id, session.workspace_id,
        ) if session.workspace_id is not None else None

        async def _load_snapshot():
            data = await load_context_data(
                db, user_id, req, profile.memory_enabled, req.message, context_policy
            )
            static_prompt, snapshot_context, _ = builder.build_split(
                profile.prompt_file.removesuffix(".md"), req.user_name,
                data.projects, data.events, data.memory, data.files_overview,
                notes=data.notes,
                skills=profile.skills, style_prefs=data.style_prefs,
                source=getattr(req, "source", None), im_channels=data.im_channels,
                im_message_format=getattr(req, "im_message_format", None),
                user_msg=req.message, non_streaming=False, user_tz=data.user_tz,
            )
            from agent.im.context_loader import format_group_memory
            group_memory = (data.im_memory or {}).get("group") or {}
            group_block = format_group_memory({"group": group_memory})
            if group_block:
                snapshot_context = f"{snapshot_context}\n\n---\n\n{group_block}"
            return {"system_prompt": static_prompt, "snapshot_context": snapshot_context,
                    "session_info": {"user_name": req.user_name, "source": req.source,
                                      "chat_id": req.chat_id, "profile": profile.prompt_file},
                    "user_tz": data.user_tz, "im_channels": data.im_channels,
                    # 共享 snapshot 只保存当前群公开记忆；成员个人记忆按请求动态读取。
                    "im_memory": {"group": group_memory},
                    "memory_summary_hash": session_snapshot.memory_summary_hash(data.memory)}

        snapshot = await session_snapshot.ensure_snapshot(db, session, load_context=_load_snapshot)
        user_tz = snapshot["user_tz"]
        set_ctx_tz(user_tz)
        from agent.im.context_loader import format_group_memory
        _legacy_group = format_group_memory({"group": (snapshot.get("im_memory") or {}).get("group") or {}})
        if _legacy_group and "## 当前群组记忆（仅限本群公开信息）" not in (snapshot.get("snapshot_context") or ""):
            snapshot["snapshot_context"] = f"{snapshot.get('snapshot_context') or ''}\n\n---\n\n{_legacy_group}"
        member_memory = await load_platform_user_memory(req)
        context_data = SimpleNamespace(im_memory={
            "group": (snapshot.get("im_memory") or {}).get("group") or {},
            "platform_user": member_memory,
        })

        # 历史读取不做本地 token 预估；预算由 provider 实际请求结果决定。
        history = await session_history.load_session_history(
            db,
            session_id,
            session_snapshot.history_baseline(session),
        )
        history_stats = session_history.consume_history_stats()
        from agent.context.provider_history import clean_persisted_history, prepare_session
        _, strip_thinking = prepare_session(session, model_cfg)
        if strip_thinking:
            clean_persisted_history(history)
            strip_thinking = False
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
        async with _sess._SessionLocal() as voice_db:
            transcript = await _voice.transcribe(
                _transcribe_media, settings, db=voice_db, user_id=user_id,
            )
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
    snapshot_context = snapshot["snapshot_context"]
    stance_text = builder.stance_block(
        await loaders.load_dynamic_memory(user_id) if profile.memory_enabled else {}
    )

    # snapshot 内容在 snapshot 有效期内保持稳定，放在 history 之前形成可缓存前缀。
    _snapshot_injection = (
        session_snapshot.snapshot_message(snapshot_context)
        if snapshot_context else None
    )

    # 组装本轮动态上下文注入块（放入 history 之后，不进 system）
    _dynamic_extra_parts = []
    _im_id = _im_identity_block(req, history)
    if _im_id:
        _dynamic_extra_parts.append(_im_id)
    if im_bridge:
        _dynamic_extra_parts.append(im_bridge)
    if _proactive_lead:
        _dynamic_extra_parts.append("\n## 你刚主动发给 TA 的消息（TA 接下来很可能在回应这条）\n\n" + _proactive_lead)
    if workspace_target:
        _workspace_name = workspace_target.get("workspace_name") or "当前工作区"
        _dynamic_extra_parts.append(
            "## 当前会话工作区（文件工具必须遵守）\n"
            f"当前绑定：{_workspace_name}；"
            f"规范落点 space={workspace_target['space']}, "
            f"project_id={workspace_target.get('project_id')}, "
            f"folder_id={workspace_target.get('folder_id')}。\n"
            "workspace_id 与 project_id/folder_id 不同命名空间；创建、保存、移动、复制、"
            "按名称查找文件时，省略目标参数即使用上述落点，不要把 workspace_id 当作 project_id。"
        )

    from agent.context import compress_conv

    # 本轮动态上下文用 [system-reminder] 包裹，避免和 snapshot 固定前缀混淆。
    _ctx_injection = None
    if _dynamic_extra_parts:
        _ctx_content = "\n\n".join(_dynamic_extra_parts)
        _ctx_injection = session_snapshot.reminder_message(_ctx_content)

    use_anthropic = run_config.use_anthropic
    tool_names = filter_tool_names(profile.tool_names, req.allowed_tool_names)
    async with _sess._SessionLocal() as tool_db:
        tool_names = await _filter_shell_tool(
            tool_db, user_id, session_id, tool_names, session=session,
        )
        capability_context = await _capability_context(
            tool_names, settings, db=tool_db, owner_id=user_id, query=aug_text,
        )
    if capability_context is not None:
        from agent.capabilities.injector import catalog_block
        _snapshot_injection = session_snapshot.snapshot_message(
            f"{snapshot_context}\n\n{catalog_block(capability_context.snapshot, tool_order=capability_context.selection.tool_names)}"
        )
    runner = LLMRunner(tool_names, settings, capability_context=capability_context)
    # 流式 IM 失败时也会产出统一的 AgentResponse，不能依赖成功分支初始化。
    im_used_tools = False

    from agent.im.context_loader import format_current_content
    current_llm_text = format_current_content(aug_text, req)
    prepared = await run_context.prepare_run(
        system_prompt=system_prompt,
        snapshot_context=snapshot_context,
        history=history,
        req=req,
        user_tz=user_tz,
        strip_thinking=strip_thinking,
        use_anthropic=use_anthropic,
        current_text=current_llm_text,
        images=aug_images,
        media=aug_media,
        model_cfg=model_cfg,
        stance_text=stance_text,
        snapshot_injection=_snapshot_injection,
        extra_reminder="\n\n".join(_dynamic_extra_parts) if _dynamic_extra_parts else None,
        user_message=user_message,
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
        on_interaction=on_interaction,
    )


    # ── 流式消费 generator（替代 _collect：逐字 yield + 末尾 yield final）──
    from agent import providers
    provider_adapter = providers.adapter_for(model_cfg)
    san = sanitize.StreamSanitizer(adapter=provider_adapter)
    rounds: list[str] = []
    cur = ""
    tin = tout = cache_read = cache_write = 0
    context_input = 0
    files: list = []
    interactions: list[dict] = []
    tool_events: list[dict] = []
    compaction_applied = False
    cancelled = False
    errored = False
    errored_text = ""
    continuation_pending = False
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
                if cur.strip():
                    from agent.interactions.events import ROUND_END
                    yield (ROUND_END, cur)
                cur = ""
                san = sanitize.StreamSanitizer(adapter=provider_adapter)
                # 这个事件由核心循环在工具结果写回后发出，表示下一轮 LLM
                # 请求已经被承诺。若生成器随后异常结束，不能把前面已流出的
                # 工具前置说明误当作最终回复。
                continuation_pending = True
            elif t == "round_start":
                continuation_pending = False
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
            elif t in {"tool_call", "tool_done"}:
                tool_event = dict(evt)
                tool_events.append(tool_event)
                await _notify_tool_event(on_tool_event, tool_event)
            elif t == "interaction_required":
                interactions.append({
                    key: evt[key]
                    for key in ("prompt_id", "kind", "title", "body", "options", "expires_at", "round_id", "tool_call_id", "force_display")
                    if key in evt
                })
            elif t == "_cancelled":
                cancelled = True
                break
            elif t == "error":
                errored_text = evt.get("message") or evt.get("detail") or "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
                errored = True
                break
    finally:
        _release_model(model_cfg)

    if continuation_pending and not cancelled and not errored:
        # 工具轮之后没有收到下一次 round_start，说明续轮在核心循环之外
        # 被截断（例如生成器提前关闭）。不允许静默成功或发布半截回复。
        errored = True
        errored_text = "工具结果已返回，但后续回复没有完成，请重试。"

    if cancelled:
        yield ("final", AgentResponse(text="", session_id=session_id,
                                      tokens_in=tin, tokens_out=tout, cancelled=True,
                                      interactions=interactions, tool_events=tool_events))
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
            text=text,
            files=files,
            tokens_in=tin,
            tokens_out=tout,
            context_tokens=run_config.context_tokens,
            actual_usage_tokens=int(context_input or tin),
            compaction_applied=compaction_applied,
        )

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

    yield ("final", AgentResponse(text=text, round_texts=[r.strip() for r in rounds if r.strip()],
                                  session_id=session_id, tokens_in=tin,
                                  tokens_out=tout, files=files, cancelled=False,
                                  used_tools=im_used_tools, interactions=interactions,
                                  tool_events=tool_events))


async def run_stream(
    req: AgentRequest,
    *,
    on_interaction=None,
    on_tool_event=None,
) -> AsyncIterator[tuple[str, object]]:
    """流式生成也复用同一 session gate，避免和普通生成并行。"""
    from agent.context import compress_conv

    final_session_id = req.session_id
    async with compress_conv.session_run_gate(req):
        async for item in _run_stream_unlocked(
            req, on_interaction=on_interaction, on_tool_event=on_tool_event,
        ):
            if isinstance(item, tuple) and len(item) == 2 and item[0] == "final":
                response = item[1]
                final_session_id = getattr(response, "session_id", None) or final_session_id
            yield item
        # 和非流式路径一致：最终帧可以先交给调用方，但 gate 要继续持有到
        # baseline 完成，保证同 session 的下一轮不会看到未提交的 baseline。
        await compress_conv.wait_for_baseline_update(final_session_id)


async def _collect(
    gen: AsyncGenerator[str, None], include_meta: bool = False,
    model_cfg=None, on_tool_event=None, on_round=None,
) -> Tuple:
    """消费 LLMRunner 的 SSE 流：清洗后攒文本 + 取用量 + 收集咕咕要发的文件。
    返回 (文本, in, out, errored, files)；errored=True 时文本是错误文案（不入历史/不反思）。

    文本按轮分段收集。兼容字段 ``text`` 仍取最后一轮；IM 展示层通过
    meta.round_texts 逐条发送，避免把多个 round 合并成一条消息，空 round 不发送。
    """
    from agent import providers
    provider_adapter = providers.adapter_for(model_cfg) if model_cfg is not None else None
    san = sanitize.StreamSanitizer(adapter=provider_adapter)
    rounds: list[str] = []   # 每轮文本分开存
    cur = ""
    tin = tout = cache_read = cache_write = 0
    context_input = 0
    files: list = []
    tool_names: list[str] = []
    interactions: list[dict] = []
    tool_events: list[dict] = []
    mutated = False
    cancelled = False
    compaction_applied = False
    continuation_pending = False
    async for evt_str in gen:
        try:
            evt = json.loads(evt_str[6:])
        except Exception:
            continue
        t = evt.get("type")
        if t == "_new_round":
            cur += san.flush()
            rounds.append(cur)
            if cur.strip():
                from agent.outbound import sanitize_outbound
                display_round = sanitize.strip_disallowed_emoji(sanitize_outbound(cur)).strip()
                await _notify_round(on_round, display_round)
            cur = ""
            san = sanitize.StreamSanitizer(adapter=provider_adapter)  # 新一轮重置清洗器
            continuation_pending = True
        elif t == "round_start":
            continuation_pending = False
        elif t == "_usage":
            tin = evt.get("input", 0)
            context_input = max(context_input, int(evt.get("context_input", tin) or 0))
            tout = evt.get("output", 0)
            cache_read = evt.get("cache_read", 0) or 0
            cache_write = evt.get("cache_write", 0) or 0
        elif t == "_context_compaction":
            compaction_applied = bool(evt.get("applied")) or compaction_applied
        elif t == "token":
            cur += san.feed(evt.get("content", ""))
        elif t == "file" and evt.get("file"):
            files.append(evt["file"])   # 咕咕用 send_file 工具要发的文件
        elif t == "tool_call":
            tool_event = dict(evt)
            tool_events.append(tool_event)
            await _notify_tool_event(on_tool_event, tool_event)
            name = str(evt.get("name") or "")
            if name and name not in tool_names:
                tool_names.append(name)
            # 按工具注册时显式声明的 mutates 判断，不再靠名字前缀猜——猜测式前缀匹配
            # 会漏掉 remember（写长期记忆）、note_undo（删笔记）这类不落在
            # create_/update_/delete_/... 词表里的写工具，导致失败后重跑整轮时
            # 重复执行已经生效的写操作。
            from agent.tools import registry as _tool_registry
            tool = _tool_registry.get(name)
            if tool is not None and tool.mutates:
                mutated = True
        elif t == "interaction_required":
            # token 只在当前事件中短暂存在，不能写入日志或历史；平台 adapter 负责决定是否展示。
            interactions.append({
                key: evt[key]
                for key in ("prompt_id", "kind", "title", "body", "options", "expires_at", "round_id", "tool_call_id", "force_display")
                if key in evt
            })
        elif t == "tool_done":
            tool_event = dict(evt)
            tool_events.append(tool_event)
            await _notify_tool_event(on_tool_event, tool_event)
        elif t == "_cancelled":
            cancelled = True   # 用户中途「算了」：停止收集，网关已回「先不继续」，worker 不再补发
            break
        elif t == "error":
            detail = evt.get("message") or evt.get("detail") or "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
            result = (detail, tin, tout, cache_read, cache_write, True, files, False)
            meta = {"tool_names": tool_names, "mutated": mutated, "interactions": interactions,
                    "tool_events": tool_events, "compaction_applied": compaction_applied,
                    "context_input": context_input,
                    "round_texts": [r.strip() for r in rounds if r.strip()]}
            return result + (meta,) if include_meta else result
    if continuation_pending and not cancelled:
        # 工具结果后的续轮没有真正开始时，禁止把上一轮的过程文字作为成功回复。
        # 这也覆盖 IM 的非流式消费路径。
        result = ("工具结果已返回，但后续回复没有完成，请重试。", tin, tout,
                  cache_read, cache_write, True, files, False)
        meta = {"tool_names": tool_names, "mutated": mutated, "interactions": interactions,
                "tool_events": tool_events, "compaction_applied": compaction_applied,
                "context_input": context_input,
                "round_texts": [r.strip() for r in rounds if r.strip()]}
        return result + (meta,) if include_meta else result
    cur += san.flush()
    rounds.append(cur)

    text = ""
    for r in reversed(rounds):
        r = r.strip()
        if r:
            text = r
            break
    result = (text, tin, tout, cache_read, cache_write, False, files, cancelled)
    round_texts = [r.strip() for r in rounds if r.strip()]
    meta = {"tool_names": tool_names, "mutated": mutated, "interactions": interactions,
            "tool_events": tool_events, "compaction_applied": compaction_applied,
            "context_input": context_input, "round_texts": round_texts}
    return result + (meta,) if include_meta else result


def _scheduled_collect_result(collected: tuple) -> tuple[str, bool, dict]:
    """把定时执行的收集结果按完整字段顺序转换成执行元数据。

    `_collect(include_meta=True)` 的返回顺序是文本、输入/输出用量、缓存用量、
    错误标记、附件、取消标记、元数据。定时任务只需要其中三项，但必须显式跳过
    中间字段，避免附件列表错位成为元数据。
    """
    text, _, _, _, _, errored, files, _, meta = collected
    execution_meta = dict(meta or {})
    execution_meta["files"] = files
    return text, errored, execution_meta


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
    run_config = resolve_run_config(settings, None)
    model_cfg = run_config.model
    try:
        import app.db.session as _sess

        if _sess._engine is None:
            _sess._build_engine()

        async with _sess._SessionLocal() as db:
            user_tz = await loaders.load_user_tz(db, user_id)
            set_ctx_tz(user_tz)
            if minimal_context:
                projects, events, files_overview, memory, im_channels = [], [], None, {}, []
                style_prefs = {}
            else:
                projects = await loaders.load_projects(db, user_id)
                events = await loaders.load_events(db, user_id, tz=user_tz)
                files_overview = await loaders.load_files_overview(db, user_id)
                memory = await loaders.load_memory(user_id) if profile.memory_enabled else {}
                im_channels = await loaders.load_im_channels(user_id)
                style_prefs = await loaders.load_style_prefs(db, user_id)

        prompt_name = profile.prompt_file.removesuffix(".md")
        static_prompt, snapshot_context, now_str = builder.build_split(
            prompt_name,
            user_name,
            projects,
            events,
            memory,
            files_overview,
            skills=profile.skills,
            style_prefs=style_prefs,
            im_channels=im_channels,
            non_streaming=True,
            include_projects=not minimal_context,
            include_calendar=not minimal_context,
            include_files=not minimal_context,
            include_memory=not minimal_context,
            user_tz=user_tz,
        )
        system_prompt = static_prompt

        use_anthropic = run_config.use_anthropic
        tool_names = (
            tool_names_override
            if tool_names_override is not None
            else profile.tool_names
        )
        # 定时任务没有交互式 session workspace，不向模型暴露本机 Shell。
        tool_names = [name for name in tool_names if name != "shell"]
        capability_context = await _capability_context(tool_names, settings, owner_id=user_id, query=prompt)
        if capability_context is not None:
            from agent.capabilities.injector import catalog_block
            snapshot_context = f"{snapshot_context}\n\n{catalog_block(capability_context.snapshot, tool_order=capability_context.selection.tool_names)}"
        runner = LLMRunner(tool_names, settings, capability_context=capability_context)

        from app.core.chat_attach import build_user_content

        if use_anthropic:
            messages = _build_scheduled_messages(
                system_prompt, snapshot_context, now_str, prompt, memory,
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
                system_prompt, snapshot_context, now_str, prompt, memory,
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
            model_cfg=model_cfg,
            include_meta=include_meta,
        )
        text, errored, meta = _scheduled_collect_result(collected)
        return (text, errored, meta) if include_meta else (text, errored)
    finally:
        _release_model(model_cfg)


def _build_scheduled_messages(system_prompt: str, snapshot_context: str,
                              now_str: str, prompt: str, memory: dict,
                              *, use_anthropic: bool, user_content=None):
    """scheduled 与 Web/IM 使用同样的动态上下文布局。"""
    fixed_parts = ([session_snapshot.snapshot_message(snapshot_context)]
                   if snapshot_context else [])
    stance_text = builder.stance_block(memory)
    if user_content is None:
        user_content = prompt
    if use_anthropic:
        messages = assembly.assemble(
            fixed_parts=fixed_parts, history=[],
            system_text=system_prompt,
        )
        batch, _ = assembly.assemble_turn(
            stance=stance_text,
            current_user={"role": "user", "content": user_content},
            now_text=now_str,
        )
        messages.append_batch(batch)
        return messages
    messages = assembly.assemble(
        fixed_parts=[{"role": "system", "content": system_prompt}] + fixed_parts,
        history=[], system_text=system_prompt,
    )
    batch, _ = assembly.assemble_turn(
        stance=stance_text,
        current_user={"role": "user", "content": user_content},
        now_text=now_str,
    )
    messages.append_batch(batch)
    return messages


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
