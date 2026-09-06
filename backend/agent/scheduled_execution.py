"""定时任务的单次非流式执行。

任务触发、锁、重试和渠道投递属于 ``app.scheduled_tasks``；本模块只负责把一次
任务转成完整的 Agent 执行，并返回正文、错误标记和执行元数据。
"""
from __future__ import annotations

from app.core.tz import set_ctx_tz
from agent.context import assembly, builder, loaders, session_snapshot, session_system
from agent.llm.llm_select import resolve_run_config_for_user, release as _release_model
from agent.profiles import DefaultProfile
from agent.runner import (
    _apply_capability_context,
    _capability_context,
    _collect,
    _filter_shell_tool,
)


def _scheduled_collect_result(collected: tuple) -> tuple[str, bool, dict]:
    """把定时执行的收集结果按完整字段顺序转换成执行元数据。

    ``_collect(include_meta=True)`` 的返回顺序是文本、输入/输出用量、缓存用量、
    错误标记、附件、取消标记、元数据。定时任务只需要其中三项，但必须显式跳过
    中间字段，避免附件列表错位成为元数据。
    """
    text, _, _, _, _, errored, files, _, meta = collected
    execution_meta = dict(meta or {})
    execution_meta["files"] = files
    return text, errored, execution_meta


def _build_scheduled_messages(
    system_prompt: str,
    snapshot_context: str,
    now_str: str,
    prompt: str,
    memory: dict,
    *,
    use_anthropic: bool,
    user_content=None,
):
    """scheduled 与 Web/IM 使用同样的动态上下文布局。"""
    fixed_parts = [session_snapshot.snapshot_message(snapshot_context)] if snapshot_context else []
    stance_text = builder.stance_block(memory)
    if user_content is None:
        user_content = prompt

    if use_anthropic:
        messages = assembly.assemble(
            fixed_parts=fixed_parts,
            history=[],
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
        history=[],
        system_text=system_prompt,
    )
    batch, _ = assembly.assemble_turn(
        stance=stance_text,
        current_user={"role": "user", "content": user_content},
        now_text=now_str,
    )
    messages.append_batch(batch)
    return messages


async def run_scheduled_once(
    user_id,
    user_name: str,
    prompt: str,
    profile,
    settings,
    *,
    include_meta: bool = False,
    tool_names_override: list[str] | None = None,
    minimal_context: bool = False,
    allowed_tools: list[str] | None = None,
    filesystem_subject: dict | None = None,
    allow_shell: bool = False,
):
    """执行一个非流式阶段；编排、重试和投递由 app.scheduled_tasks 负责。"""
    model_cfg = None
    try:
        import app.db.session as _sess
        from agent.llm import modelctx

        if _sess._engine is None:
            _sess._build_engine()

        # 定时任务是用户链路：绑定 BYOK 解析结果到 modelctx，派生的后台任务（如
        # 压缩）经 effective_ai 读到同一模型，不静默回落平台预设。
        modelctx.mark_user_scope()
        async with _sess._SessionLocal() as db:
            # 定时任务与 Web/IM 聊天走同一条 BYOK 覆盖链路：用户配置了 llm 凭据就用
            # 用户的 provider，否则原样回落平台激活预设（函数内部兜底）。
            run_config = await resolve_run_config_for_user(settings, db, user_id, None)
            model_cfg = run_config.model
            modelctx.set_model_cfg(model_cfg)
            modelctx.set_usage_context(user_id)
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
        tool_names = tool_names_override if tool_names_override is not None else profile.tool_names
        # 定时任务默认不暴露 Shell；只有任务明确绑定 workspace 或持有完整沙箱
        # 授权时，才沿用 DefaultProfile 中的 shell 工具，并在 dispatch 边界再次
        # 按 filesystem_subject 校验，不能仅靠工具列表作为权限边界。
        if not allow_shell:
            tool_names = [name for name in tool_names if name not in {"shell", "run_script"}]
        subject = filesystem_subject or {}
        if str(subject.get("subject_type") or "") == "scheduled_task" and not subject.get("script_authorization"):
            tool_names = [name for name in tool_names if name != "run_script"]

        shell_prompt = None
        if "shell" in tool_names:
            async with _sess._SessionLocal() as policy_db:
                tool_names = await _filter_shell_tool(
                    policy_db,
                    user_id,
                    None,
                    tool_names,
                    subject_type=str(subject.get("subject_type") or "session"),
                    subject_id=subject.get("subject_id"),
                    workspace_id=subject.get("workspace_id"),
                )
                if "shell" in tool_names:
                    from agent.security.shell_policy import build_dynamic_prompt

                    shell_prompt = await build_dynamic_prompt(
                        policy_db,
                        user_id,
                        None,
                        subject_type=str(subject.get("subject_type") or "session"),
                        subject_id=subject.get("subject_id"),
                        workspace_id=subject.get("workspace_id"),
                    )
                    if shell_prompt is None:
                        tool_names = [name for name in tool_names if name not in {"shell", "run_script"}]

        system_prompt = session_system.append_shell_prompt(system_prompt, enabled="shell" in tool_names)
        if shell_prompt:
            system_prompt = "\n\n---\n\n".join((system_prompt, shell_prompt))
        capability_context = await _capability_context(tool_names, settings, owner_id=user_id, query=prompt)
        system_prompt, snapshot_context = _apply_capability_context(
            system_prompt,
            snapshot_context,
            capability_context,
        )

        from agent.scheduled import ScheduledLLMRunner

        scheduled_runner = ScheduledLLMRunner(
            tool_names,
            settings,
            capability_context=capability_context,
        )

        from app.core.chat_attach import build_user_content

        if use_anthropic:
            messages = _build_scheduled_messages(
                system_prompt,
                snapshot_context,
                now_str,
                prompt,
                memory,
                use_anthropic=True,
                user_content=build_user_content(prompt, [], True),
            )
            gen = scheduled_runner.run(
                user_id,
                system_prompt,
                messages,
                use_anthropic=True,
                model_cfg=model_cfg,
                # 定时任务没有稳定的会话续接边界；provider state 只属于交互式 session。
                reasoning_policy="off",
                state_session_factory=None,
            )
        else:
            messages = _build_scheduled_messages(
                system_prompt,
                snapshot_context,
                now_str,
                prompt,
                memory,
                use_anthropic=False,
                user_content=prompt,
            )
            gen = scheduled_runner.run(
                user_id,
                None,
                messages,
                use_anthropic=False,
                model_cfg=model_cfg,
                reasoning_policy="off",
                state_session_factory=None,
            )

        # 定时任务由用户创建并明确授权其指令执行；只给邮件工具自动授权，
        # 其它 destructive 工具仍必须经过各自安全门，不能借任务上下文扩大权限。
        from agent.tools.base import (
            reset_automation_allowed_tools,
            reset_dispatch_filesystem_subject,
            set_automation_allowed_tools,
            set_dispatch_filesystem_subject,
        )

        automation_token = set_automation_allowed_tools(set(allowed_tools or []))
        filesystem_token = set_dispatch_filesystem_subject(filesystem_subject)
        try:
            collected = await _collect(
                gen,
                model_cfg=model_cfg,
                include_meta=include_meta,
            )
        finally:
            reset_dispatch_filesystem_subject(filesystem_token)
            reset_automation_allowed_tools(automation_token)

        text, errored, meta = _scheduled_collect_result(collected)
        from agent.usage import record_usage

        _, tokens_in, tokens_out, cache_read, cache_write, *_ = collected
        try:
            await record_usage(
                user_id,
                settings,
                model_cfg,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                cache_read=cache_read,
                cache_write=cache_write,
                tools_used=meta.get("tool_names") or None,
            )
        except Exception as exc:
            from app.core.redaction import diag_log

            diag_log("agent.usage.scheduled", exc)
        return (text, errored, meta) if include_meta else (text, errored)
    finally:
        _release_model(model_cfg)


async def run_scheduled_execution(
    user_id,
    user_name: str,
    prompt: str,
    *,
    allowed_tools: list[str] | None = None,
    filesystem_subject: dict | None = None,
    allow_shell: bool = False,
):
    """执行阶段适配器；自动工具权限来自任务持久化授权，不默认放行。"""
    from app.core.config import get_settings

    return await run_scheduled_once(
        user_id,
        user_name,
        prompt,
        DefaultProfile(),
        get_settings(),
        include_meta=True,
        allowed_tools=allowed_tools,
        filesystem_subject=filesystem_subject,
        allow_shell=allow_shell,
    )
