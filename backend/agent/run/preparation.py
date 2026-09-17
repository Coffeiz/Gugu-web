"""统一的第一段 run 准备（PRD-LLM-18 LLM18-002，FR-RUN-01/03）。

collect/stream（以及后续 web）入口共用的唯一准备实现：会话解析、snapshot/history
读取、附件与语音、配额、连续性桥、工具能力（含 MCP 按需装载）和 PreparedRun 组装，
按固定顺序执行一次。入口差异只允许两类（FR-RUN-03）：

- ``non_streaming``：builder 的流式参数差异（snapshot 尾部是否追加
  NON_STREAMING_BLOCK 行为提示），对应"provider 流式参数"这一允许差异；
- 用户消息广播的 ``origin``：Web 入口带发起标签页 origin 供回声抑制，IM 无此概念。

本模块只负责"准备"，不负责事件消费与持久化（分别在 runner 入口 / run_finalize）。
所有 ``_SessionLocal`` 访问都经 ``app.db.session`` 模块属性在调用时取，保持测试
桩（conftest 把 _SessionLocal 接到内存库）可以生效。
"""
from __future__ import annotations

from app.core.config import get_settings
from app.core.tz import set_ctx_tz

from agent import quota
from agent.context import builder, dynamic_tail, loaders, run_context, session_snapshot, session_history, session_system
from agent.context.provider_history import clean_persisted_history, prepare_session
from agent.core import LLMRunner
from agent.capabilities.defaults import DEFAULT_PROMPT_NAME, SYSTEM_MEMORY_ENABLED, all_system_tool_names
from agent.im.context_policy import IM_SOURCES, policy_for
from agent.im.context_loader import load_context_data
from agent.im.context_runtime import (
    continuity_bridge,
    im_identity_block,
    proactive_lead_for,
    snapshot_im_memory as add_im_memory_to_snapshot,
    with_quoted_context,
)
from agent.im.permissions import filter_tool_names
from agent.im.session import get_or_create_session
from agent.llm.llm_select import resolve_run_config, resolve_run_config_for_user, release as _release_model
from agent.models import AgentRequest
from agent.run.contract import (
    EARLY_EXIT_ATTACHMENT,
    EARLY_EXIT_QUOTA,
    EARLY_EXIT_VOICE,
    EarlyExit,
    PreparedExecution,
)


async def _load_mcp_tools(user_id, settings, allowed_tool_names=None):
    """按用户惰性载入 MCP 工具；不写入全局 Tool registry。

    MCP 是增强能力：任何装载期异常（DB 不可用、会话桩不可用等）都降级为空集，
    绝不阻断主流程（FR-MCP-5：失败不影响 builtin 工具与主对话）。
    """
    from agent.mcp.manager import mcp_manager

    try:
        tools = await mcp_manager.list_user_tools(user_id)
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.runner.load_mcp_tools", exc)
        return []
    if allowed_tool_names is None:
        return tools
    allowed = set(allowed_tool_names)
    return [tool for tool in tools if tool.name in allowed]


def _session_user_skill_metadata(session):
    """读取当前会话冻结的用户 Skill 目录；缺失时返回 None，允许首次建立。"""
    from agent.capabilities.skill_registry import deserialize_user_skill_metadata

    context = getattr(session, "session_context", None) or {}
    if "user_skill_snapshot" not in context:
        return None
    return deserialize_user_skill_metadata(context.get("user_skill_snapshot"))


def _pin_session_user_skill_metadata(session, capability_context) -> bool:
    """首次组装后把用户 Skill 目录写入 session snapshot；返回是否发生写入。"""
    context = dict(getattr(session, "session_context", None) or {})
    if "user_skill_snapshot" in context:
        return False
    from agent.capabilities.skill_registry import serialize_user_skill_metadata

    user_items = tuple(
        item for item in capability_context.snapshot.skills.values()
        if item.source == "user"
    )
    context["user_skill_snapshot"] = serialize_user_skill_metadata(user_items)
    session.session_context = context
    return True


async def _capability_context(tool_names, settings, *, db=None, owner_id=None, query="",
                              user_skill_metadata=None, dynamic_tools=()):
    """按用户偏好创建能力上下文；full-schema 仍保留真实工具 Schema。"""
    from agent.capabilities.injector import (
        build_fixed_adapter_context,
        build_fixed_adapter_context_for_user,
        build_skill_metadata_context_for_user,
    )
    async def _full_schema_preference(session):
        if owner_id is None:
            return False
        from app.models import UserPreferences
        from sqlalchemy import select
        row = await session.scalar(select(UserPreferences).where(UserPreferences.user_id == owner_id))
        stored_mode = (row.data or {}).get("tool_injection_mode") if row else None
        if stored_mode is None:
            return True
        return stored_mode not in {"description", "catalog"}

    if db is None and owner_id is not None:
        import app.db.session as _sess
        if _sess._engine is None:
            _sess._build_engine()
        async with _sess._SessionLocal() as capability_db:
            if await _full_schema_preference(capability_db):
                return await build_skill_metadata_context_for_user(
                    tool_names, db=capability_db, owner_id=owner_id, search_settings=settings,
                    user_skill_metadata=user_skill_metadata, dynamic_tools=dynamic_tools,
                )
            context = await build_fixed_adapter_context_for_user(
                tool_names, db=capability_db, owner_id=owner_id, search_settings=settings,
                user_skill_metadata=user_skill_metadata, dynamic_tools=dynamic_tools,
            )
            if query:
                await context.select_for_query(query)
            return context
    if db is not None and owner_id is not None:
        if await _full_schema_preference(db):
            return await build_skill_metadata_context_for_user(
                tool_names, db=db, owner_id=owner_id, search_settings=settings,
                user_skill_metadata=user_skill_metadata, dynamic_tools=dynamic_tools,
            )
        context = await build_fixed_adapter_context_for_user(
            tool_names, db=db, owner_id=owner_id, search_settings=settings,
            user_skill_metadata=user_skill_metadata, dynamic_tools=dynamic_tools,
        )
        if query:
            await context.select_for_query(query)
        return context
    context = build_fixed_adapter_context(tool_names, search_settings=settings, owner_id=owner_id)
    if query:
        await context.select_for_query(query)
    return context


def _apply_capability_context(system_prompt: str, snapshot_context: str, context):
    """按工具注入模式分配目录：简介进 system，用户 Skill 元数据进 snapshot。"""
    if context is None:
        return system_prompt, snapshot_context
    from agent.capabilities.injector import catalog_block

    skill_catalog = catalog_block(
        context.snapshot, kind="skill", tool_order=context.snapshot.tools,
    )
    if getattr(context, "metadata_only", False):
        # 完整 Schema 由 Provider 的 tools 字段提供，不在消息里重复工具简介。
        return system_prompt, "\n\n---\n\n".join((snapshot_context, skill_catalog))

    tool_catalog = catalog_block(
        context.snapshot, kind="tool", tool_order=context.snapshot.tools,
    )
    return (
        "\n\n---\n\n".join((system_prompt, tool_catalog)),
        "\n\n---\n\n".join((snapshot_context, skill_catalog)),
    )


async def _filter_shell_tool(
    db,
    user_id,
    session_id: int | None,
    names: list[str],
    *,
    session=None,
    subject_type: str = "session",
    subject_id: int | str | None = None,
    workspace_id: int | None = None,
) -> list[str]:
    """工具注册前过滤存储相关工具和 Shell；执行器仍会再次调用策略层复核。"""
    # OSS 文件库没有本地挂载语义；工作区工具不能仅靠 handler 返回空列表，
    # 否则模型仍会误以为可以创建或绑定 workspace。
    from app.services.workspaces import workspace_shell_supported
    if not workspace_shell_supported():
        names = [name for name in names if name != "workspaces"]
    if "shell" not in names:
        return names
    if subject_type == "session" and not session_id:
        return [name for name in names if name != "shell"]
    from agent.security.shell_policy import evaluate
    decision = await evaluate(
        db,
        user_id,
        session_id,
        "pwd",
        session=session,
        subject_type=subject_type,
        subject_id=subject_id,
        workspace_id=workspace_id,
    )
    if decision.allowed and not decision.needs_confirmation:
        return names
    return [name for name in names if name != "shell"]


async def prepare_agent_run(req: AgentRequest, *, non_streaming: bool) -> PreparedExecution | EarlyExit:
    """统一第一段准备；返回执行快照，或准备期即确定的 EarlyExit 终态。

    ``non_streaming`` 是 collect/stream 唯一的组装差异（builder 追加
    NON_STREAMING_BLOCK 行为提示），对齐 FR-RUN-03 允许的"provider 流式参数"差异。
    """
    user_id = req.user_id
    settings = get_settings()
    # 用户链路标记：modelctx 兜底哨兵从此生效，后台派生任务不得静默烧平台配额
    from agent.llm import modelctx
    modelctx.mark_user_scope()
    run_config = resolve_run_config(settings, req)
    context_policy = policy_for(req)
    # 不强切 vision 模型：这轮 pick 到的模型看得了图就识图、看不了就当普通文件存。
    # 避免硬切到「标了 vision 实则不收图片块」的模型（如 MiniMax 兼容口）。

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import ConversationMessage

    async with _sess._SessionLocal() as db:
        run_config = await resolve_run_config_for_user(settings, db, user_id, req)
        model_cfg = run_config.model
        modelctx.set_model_cfg(model_cfg)   # 后台任务（反思/总结/压缩）经 create_task 继承此绑定
        from app.byok.service import resolve_and_bind_user_embedding
        await resolve_and_bind_user_embedding(settings, db, user_id)   # 记忆/RAG 向量化走用户 embedding 凭据（PRD-SEC-2）
        session_state = await get_or_create_session(db, req, user_id)
        session, is_new_session = session_state.session, session_state.is_new
        session_id = session.id
        modelctx.set_usage_context(user_id, session_id)
        from app.services.workspaces import resolve_workspace_target
        workspace_target = await resolve_workspace_target(
            db, user_id, session.workspace_id,
        ) if session.workspace_id is not None else None
        workspace_binding = session_snapshot.workspace_binding_key(workspace_target)

        async def _load_snapshot():
            data = await load_context_data(
                db, user_id, req, SYSTEM_MEMORY_ENABLED, req.message, context_policy
            )
            static_prompt, snapshot_context, _ = builder.build_split(
                DEFAULT_PROMPT_NAME, req.user_name,
                data.projects, data.events, data.memory, data.files_overview,
                notes=data.notes,
                style_prefs=data.style_prefs,
                source=getattr(req, "source", None), im_channels=data.im_channels,
                im_message_format=getattr(req, "im_message_format", None),
                user_msg=req.message, non_streaming=non_streaming, user_tz=data.user_tz,
                knowledge=data.knowledge,
            )
            snapshot_context, snapshot_im_memory = add_im_memory_to_snapshot(
                snapshot_context, data.im_memory, req,
                restricted=context_policy.restricted,
            )
            workspace_block = session_snapshot.workspace_snapshot_block(workspace_target)
            if workspace_block:
                snapshot_context = "\n\n---\n\n".join((snapshot_context, workspace_block))
            return {
                "system_prompt": static_prompt,
                "snapshot_context": snapshot_context,
                "session_info": {"user_name": req.user_name, "source": req.source,
                                  "chat_id": req.chat_id, "prompt": f"{DEFAULT_PROMPT_NAME}.md"},
                "user_tz": data.user_tz,
                "im_channels": data.im_channels,
                # 共享 snapshot 只保存当前群公开记忆；成员个人记忆按请求动态读取。
                "im_memory": snapshot_im_memory,
                "memory_summary_hash": session_snapshot.memory_summary_hash(data.memory),
            }

        async def _load_system_prompt(current_user_tz):
            style_prefs = await loaders.load_style_prefs(db, user_id)
            return builder.build_static_prompt(
                DEFAULT_PROMPT_NAME, req.user_name,
                style_prefs=style_prefs,
                current_date=dynamic_tail.current_date_text(current_user_tz),
            )

        snapshot = await session_snapshot.ensure_snapshot(
            db, session, load_context=_load_snapshot,
            workspace_binding=workspace_binding,
        )
        snapshot_user_tz = snapshot["user_tz"]
        snapshot["system_prompt"] = await _load_system_prompt(snapshot_user_tz)
        user_tz = snapshot["user_tz"]
        set_ctx_tz(user_tz)
        # 兼容旧 snapshot：旧版本把群记忆放在动态尾部（正文无群记忆标题）时恢复到
        # 正文。collect/stream 曾各有一份等价实现（helper + 内联），这里收成单一实现。
        from agent.im.context_loader import restore_group_memory_snapshot
        restore_group_memory_snapshot(snapshot)

        # 历史读取不做本地 token 预估；预算由 provider 实际请求结果决定。
        history = await session_history.load_session_history(
            db,
            session_id,
            session_snapshot.history_baseline(session),
        )
        history_stats = session_history.consume_history_stats()
        _, strip_thinking = prepare_session(session, model_cfg)
        if strip_thinking:
            clean_persisted_history(history)
            strip_thinking = False
        # 主动推送（定时任务/活动提醒）若是会话首条 assistant（前导，sanitize 会剥掉）→ 记下来塞进 system，
        # 让咕咕知道「自己刚主动发了啥」、能接住用户对它的回复（如新闻速览后用户回「4」）。
        # 主动推送桥只保留群聊行为；私聊不把历史首条主动消息重复塞进每轮尾部。
        _proactive_lead = proactive_lead_for(req, history)

        # 附件（IM 收到的文件）：文本读内容注入给模型，卡片随用户消息持久化（和网页同一套）
        from app.core import chat_attach
        llm_text = with_quoted_context(req.message, getattr(req, "quoted_text", None))
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
            return EarlyExit(EARLY_EXIT_ATTACHMENT, AgentResponse(
                text="附件已失效（可能已被使用或清理），请重新发送", session_id=session_id))
        await db.commit()

        # 精力耗尽 → 硬拦（IM / 定时任务，与网页 web.stream 同口径）：用户消息已记，不再生成，直接回一句
        if await quota.is_exhausted(db, user_id, settings):
            return EarlyExit(EARLY_EXIT_QUOTA, AgentResponse(
                text="咕咕累了，休息会儿再来～", session_id=session_id, tokens_in=0, tokens_out=0))

        # IM 新会话「续接桥」：趁 db 还开着查上一条对话，给指针/尾部，免得 12h TTL 起新会话后
        # 用户说「继续刚刚」咕咕空着答（web 有自己的会话续接 + 可手动选历史，无需此桥）。
        im_bridge = ""
        if is_new_session and context_policy.allow_continuity_bridge:
            try:
                im_bridge = await continuity_bridge(
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

    # 用户消息先推给网页：一存下就推（先看到「我发了什么」），回复生成完再推第二次。
    # origin 是 Web 入口的回声抑制标识（发起标签页跳过这条广播）；IM 入口无此概念。
    try:
        from app.core import events as _evmod
        await _evmod.publish(user_id, "sessions", session_id=session_id,
                             origin=getattr(req, "origin", None),
                             appended=[{"role": "user", "text": req.message, "files": attach_cards or None,
                                        "quoted_text": getattr(req, "quoted_text", None),
                                        "platform_user_id": req.platform_user_id,
                                        "platform_user_name": req.platform_user_name,
                                        "platform_bot_user_id": req.platform_bot_user_id}])
    except Exception:
        pass

    # 主模型支持音频时直接保留音频块；否则才用独立配置的「语音识别模型」
    # 转成文字交给主模型。两者都不可用时，resolve_for_message 已留下不支持提示。
    _transcribe_media = [m for m in aug_media if m.get("type") != "video"]
    if _transcribe_media and chat_attach.should_transcribe_audio(model_cfg):
        from agent import voice as _voice
        # 上面的会话读取事务已经结束，不能继续复用已退出上下文的 db；
        # 语音模型解析需要独立短事务，避免把连接带进后续 LLM 等待。
        async with _sess._SessionLocal() as voice_db:
            transcript = await _voice.transcribe(
                _transcribe_media, settings, db=voice_db, user_id=user_id,
            )
        if transcript is None:        # 未配置语音模型
            _release_model(model_cfg)
            return EarlyExit(EARLY_EXIT_VOICE, AgentResponse(
                text="抱歉，我现在还不能处理语音 / 音视频消息哦，打字告诉我就行～",
                session_id=session_id, tokens_in=0, tokens_out=0))
        spoken = transcript.strip() or "（用户发来一段语音，但这次没听清内容）"
        aug_text = (aug_text + "\n" if aug_text else "") + f"（用户发来语音，内容是：）{spoken}"
        aug_media = [m for m in aug_media if m.get("type") == "video"]

    system_prompt = snapshot["system_prompt"]
    snapshot_context = snapshot["snapshot_context"]
    stance_text = builder.stance_block(
        await loaders.load_dynamic_memory(user_id) if SYSTEM_MEMORY_ENABLED else {}
    )

    # snapshot 内容在 snapshot 有效期内保持稳定，放在 history 之前形成可缓存前缀。
    _snapshot_injection = (
        session_snapshot.snapshot_message(snapshot_context)
        if snapshot_context else None
    )

    # 组装本轮动态上下文注入块（放入 history 之后，不进 system）
    _dynamic_extra_parts = []
    _im_id = im_identity_block(req, history)
    if _im_id:
        _dynamic_extra_parts.append(_im_id)
    if im_bridge:
        _dynamic_extra_parts.append(im_bridge)
    if _proactive_lead:
        _dynamic_extra_parts.append("\n## 你刚主动发给 TA 的消息（TA 接下来很可能在回应这条）\n\n" + _proactive_lead)

    use_anthropic = run_config.use_anthropic
    tool_names = filter_tool_names(all_system_tool_names(), req.allowed_tool_names)
    mcp_tools = await _load_mcp_tools(user_id, settings, req.allowed_tool_names)
    modelctx.set_usage_context(
        user_id, session_id, scenario="mcp" if mcp_tools else "chat",
    )
    user_skill_metadata = _session_user_skill_metadata(session)
    # 这里同样使用短事务。工具组装可能触发数据库查询，不能把前面已关闭的
    # session 传入，否则 AsyncSession 会在上下文外重新 checkout 连接并由 GC 回收。
    async with _sess._SessionLocal() as tool_db:
        tool_names = await _filter_shell_tool(
            tool_db, user_id, session_id, tool_names, session=session,
        )
        if "shell" in tool_names:
            from agent.security.shell_policy import build_dynamic_prompt
            shell_prompt = await build_dynamic_prompt(
                tool_db, user_id, session_id, session=session,
            )
            if shell_prompt:
                system_prompt = session_system.append_shell_prompt(system_prompt, enabled=True)
                system_prompt = "\n\n---\n\n".join((system_prompt, shell_prompt))
            else:
                tool_names = [name for name in tool_names if name not in {"shell", "run_script"}]
        capability_context = await _capability_context(
            tool_names, settings, db=tool_db, owner_id=user_id, query=aug_text,
            user_skill_metadata=user_skill_metadata, dynamic_tools=mcp_tools,
        )
    system_prompt = session_system.append_shell_prompt(system_prompt, enabled="shell" in tool_names)
    if capability_context is not None:
        _pin_session_user_skill_metadata(session, capability_context)
    system_prompt, snapshot_context = _apply_capability_context(
        system_prompt, snapshot_context, capability_context,
    )
    if capability_context is not None:
        _snapshot_injection = session_snapshot.snapshot_message(snapshot_context)
    runner = LLMRunner(
        tool_names, settings, capability_context=capability_context,
        locale=getattr(req, "locale", None),
        dynamic_tools=mcp_tools,
    )

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

    return PreparedExecution(
        session_id=session_id,
        is_new_session=is_new_session,
        session=session,
        snapshot=snapshot,
        system_prompt=system_prompt,
        user_message=user_message,
        model_cfg=model_cfg,
        run_config=run_config,
        use_anthropic=use_anthropic,
        context_policy=context_policy,
        runner=runner,
        prepared=prepared,
        session_factory=_sess._SessionLocal,
        settings=settings,
    )
