"""IM 消息分发与运行编排。"""
from __future__ import annotations

import asyncio
from functools import partial

from agent.im.models import PlatformMessage
from agent.im.permissions import resolve_group_policy
from agent.im.activity import (
    bind_im_context,
    finalize_im_response,
    finish_im_activity,
    remember_im_reach,
    start_im_activity,
    stop_im_typing,
)
from agent.im.commands import handle_im_command
from agent.im.conversation import (
    persist_im_session,
    record_passive_im_message,
    should_record_passive_group,
)
from agent.im.presentation import (
    _create_feishu_tool_summary,
    _im_display_preferences,
    _send_interaction_prompts,
    display_tool_event,
)
from agent.im.request_preparation import (
    _ensure_im_session,
    prepare_message,
)
from agent.im.shortcuts import (
    _qq_private_streaming_requested,
    apply_im_shortcut_cancel,
    decide_im_shortcut,
)
from agent.im.dispatch_finalization import finalize_im_dispatch
from agent.im.stream_bridge import ImWebStreamBridge

async def dispatch_im_message(payload: dict):
    """处理一条已入队 IM 消息的完整业务编排。

    Redis worker 只负责消费、去重、防抖和生命周期；身份、权限、被动记录、
    shortcut、模型执行、session 写回和出站回复均在这里完成，三平台共用同一条
    可测试的 IM Loop。
    """
    from agent.runtime import trace
    from agent.im.replies import send_text
    from agent.runner import run_collect, run_stream

    # 在绑定命令、媒体下载、普通消息持久化、被动群记录和 Agent 前消费凭据输入。
    from agent.im.interaction_text import consume_mcp_secret_payload

    if await consume_mcp_secret_payload(payload):
        return None

    # Telegram owner 只能通过网页签发的一次性绑定码，在 Bot 私聊中显式绑定。
    # 必须在构造 AgentRequest/调用模型前短路，避免验证码进入模型上下文或聊天历史。
    if payload.get("platform") == "telegram" and payload.get("telegram_command") == "bind":
        if payload.get("chat_type") != "c2c":
            return None
        from uuid import UUID
        from app.services.im_identity import consume_telegram_binding_code

        text_value = str(payload.get("text") or "")
        parts = text_value.split(maxsplit=1)
        code = parts[1] if len(parts) == 2 else ""
        try:
            bound = await consume_telegram_binding_code(
                int(payload.get("channel_id") or 0),
                UUID(str(payload.get("owner_user_id") or "")),
                str(payload.get("platform_user_id") or ""),
                code,
            )
        except (TypeError, ValueError):
            bound = False
        from agent.gateway.telegram import send_message
        await send_message(
            str(payload.get("chat_id") or payload.get("platform_user_id") or ""),
            "绑定成功。" if bound else "绑定码无效、已过期或已使用，请回到咕咕设置重新生成。",
            channel_id=str(payload.get("channel_id") or ""),
            reply_to_message_id=str(payload.get("message_id") or "") or None,
        )
        if bound:
            from app.core import events
            await events.publish(
                UUID(str(payload.get("owner_user_id"))), "im_channels", operation="refresh"
        )
        return None

    # Gateway 入口和 Redis 队列消费之间可能存在设置变化；worker 再读取对应
    # 平台 Bot 的策略，既阻止关闭后的旧消息，也确保两个 IM 不串用群聊开关。
    if payload.get("platform") in {"qq", "feishu", "telegram"} and payload.get("chat_type") == "group":
        platform = str(payload.get("platform"))
        group_settings = await resolve_group_policy(
            str(payload.get("channel_id") or ""), platform=platform
        )
        if not group_settings[0]:
            return None
        payload = dict(payload)
        payload["group_requires_at"] = group_settings[1]
        payload["group_read_enabled"] = group_settings[2]
        payload["group_memory_enabled"] = group_settings[3]
        payload["member_memory_enabled"] = group_settings[4]

    if payload.get("platform") == "qq":
        raw_attachments = payload.get("attachments") or []
        # 系统表情可能只有 emoji_refs，没有 QQ 原始附件；两者都要经过媒体入口，
        # 否则 QFace 无法补图，最终只会保留网关的占位文本。
        if any(isinstance(item, dict) for item in raw_attachments) or payload.get("emoji_refs"):
            from agent.im.media_ingress import IM_SIZE_LIMIT_NOTICE, ingest_qq_media

            payload = dict(payload)
            media_result = await ingest_qq_media(
                raw_attachments,
                str(payload.get("owner_user_id") or ""),
                str(payload.get("message_id") or ""),
                payload.get("emoji_refs") or [],
                str(payload.get("platform_message_id") or ""),
            )
            payload["attachments"] = media_result.attachment_ids
            if media_result.failure_notice:
                # 附件下载/暂存失败要明确回一句：否则用户发完文件既没有秒回、
                # 也没有错误提示，会以为机器人根本没收到。
                await send_text(payload, media_result.failure_notice)
            if media_result.size_limit_exceeded:
                await send_text(
                    payload,
                    IM_SIZE_LIMIT_NOTICE,
                )
            # 提示都发完再判空：下载失败与超限可能同时出现，先发的那条不能把后一条吞掉。
            if (
                (media_result.failure_notice or media_result.size_limit_exceeded)
                and not payload["attachments"]
                and not str(payload.get("text") or "").strip()
            ):
                return None
            # faceType=3 的 ext 可能带一个文字标签；QFace 成功补图后，纯表情消息
            # 不应同时展示标签和图片。未匹配到资源时保留网关的兜底文字。
            if payload.get("emoji_refs") and not any(
                isinstance(item, dict) for item in raw_attachments
            ) and payload["attachments"]:
                payload["text"] = ""
        if payload.get("platform_bot_user_id"):
            from agent.im.identity import remember_bot_platform_user_id

            await remember_bot_platform_user_id(
                str(payload.get("channel_id") or ""),
                str(payload["platform_bot_user_id"]),
            )
    elif payload.get("platform") == "telegram" and (
        payload.get("attachments") or payload.get("quoted_attachments")
    ):
        from agent.im.media_ingress import ingest_telegram_media

        payload = dict(payload)
        media_result = await ingest_telegram_media(
            payload.get("attachments") or [],
            payload.get("quoted_attachments") or [],
            payload.get("owner_user_id"),
            str(payload.get("channel_id") or ""),
            payload.get("attachment_source_message_id"),
        )
        payload["attachments"] = media_result.attachment_ids
        if media_result.failure_notice:
            await send_text(payload, media_result.failure_notice)
            if not payload["attachments"] and not str(payload.get("text") or "").strip():
                return None

    platform_message = PlatformMessage.from_payload(payload)
    payload = platform_message.to_payload(payload)
    prepared = await prepare_message(payload, platform_message)
    if prepared is None:
        await send_text(payload, "你好，我是咕咕 🐦\n这个机器人还没和咕咕账号关联好，去咕咕「个人设置 → 接入咕咕」重新扫码连接一下吧。")
        return None

    req = prepared.request
    user_id = req.user_id
    platform = prepared.actor.platform
    puid = prepared.actor.platform_user_id
    route = prepared.session_route
    session_scope = route.scope_id
    req.session_id = prepared.session_id
    trace_id = trace.set_trace(payload.get("trace_id"))
    trace.bind_im_run(prepared.session_id, platform)
    from agent.im.mentions import payload_semantic_text
    semantic_text = payload_semantic_text(payload, req.message)

    # 文本降级选项必须先于 shortcut/模型执行消费，否则微信、飞书的数字回复
    # 会被当成新一轮用户消息；QQ 也统一走这里，避免网关各自维护一套解析。
    if not req.attachments and req.message.strip():
        from agent.im.interaction_text import consume_text_choice

        try:
            interaction_result = await consume_text_choice(
                user_id=user_id,
                session_id=prepared.session_id,
                text=req.message,
                event_id=payload.get("message_id"),
                platform=platform,
                bot_id=route.bot_id,
                chat_id=req.chat_id,
                platform_user_id=puid,
                bot_mentioned=bool(payload.get("bot_mentioned", payload.get("group_mentioned"))),
            )
        except Exception as exc:
            from app.core.redaction import diag_log

            diag_log("agent.im.interaction_text.consume", exc)
            interaction_result = None
        if interaction_result is not None:
            result_payload = interaction_result.get("result") or {}
            if result_payload.get("status") == "awaiting_text":
                await send_text(payload, "请直接发送你的回复，咕咕会继续处理。")
                trace.finish_run("success")
                return None
            selected_text = str(
                result_payload.get("text")
                or interaction_result.get("option_id")
                or "已选择"
            )
            await send_text(payload, f"已选择：{selected_text}，继续处理。")
            trace.finish_run("success")
            return None

    if should_record_passive_group(req, payload):
        passive_sid = await record_passive_im_message(req, prepared.session_id)
        await persist_im_session(platform, route.bot_id, session_scope, passive_sid, group=True)
        trace.bind_im_run(passive_sid, platform)
        # 被动群消息只落库/供反思，不进入 Agent 执行链路；不要把零 usage
        # 的临时 trace 上报给 LoopScope，避免污染运行次数和缓存统计。
        trace.discard_run()
        print(f"[im-loop] {platform} 群聊普通消息已记录(session={passive_sid} trace={trace_id})", flush=True)
        return None

    shortcut = await decide_im_shortcut(
        platform,
        puid or "",
        semantic_text,
        has_attachments=bool(req.attachments),
        bot_id=route.bot_id,
        scope_id=session_scope,
        allow_leading_mention=bool(payload.get("group_mentioned")),
    )
    if shortcut["action"] == "drop":
        trace.finish_run("success")
        return None
    if shortcut["action"] in ("reply", "cancel"):
        # bot_id/scope_id 必须一起传——request_cancel() 要求 platform+bot_id+scope_id+puid
        # 全部非空才会真正写标志，否则静默 no-op（code review 发现：这里漏传导致 fallback
        # 路径的取消从来没真正生效过，QQ 主路径因为走了另一条已正确传 scope 的路径掩盖了这个问题）。
        await apply_im_shortcut_cancel(platform, puid or "", shortcut, bot_id=route.bot_id, scope_id=session_scope)
        await send_text(payload, shortcut["reply"])
        trace.finish_run("cancelled" if shortcut["action"] == "cancel" else "success", shortcut["reply"])
        await finalize_im_response(platform, puid or "", shortcut["action"] == "cancel", shortcut["reply"])
        return None
    if shortcut["action"] == "no_permission":
        # 咕咕在跑别人的 loop，当前用户无权取消：回一句提示，不入队。
        await send_text(payload, shortcut["reply"])
        trace.finish_run("success", shortcut["reply"])
        return None

    # 命令在 Agent runner 之前短路，但 IM 路由可能仍持有已删除的 Redis session id。
    # 先按当前作用域恢复/创建真实会话，避免 /new、/workspace 等命令落到失效 id。
    from agent import commands as _commands
    command_name, command_arg = _commands.parse(
        semantic_text,
        allow_leading_mention=False,
    )
    if command_name is not None:
        denial = _commands.im_command_permission_denial(
            command_name,
            command_arg,
            req.im_role or "unknown",
            payload.get("locale"),
        )
        if denial is not None:
            await send_text(payload, denial)
            trace.finish_run("success", denial)
            return None
    goal_start, goal_text = _commands.is_goal_start(semantic_text)
    if command_name is not None:
        import app.db.session as _db_session
        from agent.im.session import get_or_create_session

        if _db_session._engine is None:
            _db_session._build_engine()
        async with _db_session._SessionLocal() as command_db:
            command_state = await get_or_create_session(command_db, req, user_id)
            await command_db.commit()
        req.session_id = command_state.session.id
        await persist_im_session(platform, route.bot_id, session_scope, req.session_id, group=route.is_group)
        trace.bind_im_run(req.session_id, platform)

    cmd_reply = await handle_im_command(
        user_id,
        semantic_text,
        req.session_id,
        allow_leading_mention=False,
    )
    if cmd_reply is not None and not goal_start:
        if isinstance(cmd_reply, dict) and cmd_reply.get("_command_interaction"):
            prompt = cmd_reply.get("prompt") or {}
            sent = await _send_interaction_prompts(payload, [prompt])
            if not sent:
                from app.core.redaction import diag_log_raw
                diag_log_raw(
                    "agent.im.command_interaction_display",
                    f"send_failed platform={platform} chat_type={payload.get('chat_type')} "
                    f"prompt_id={prompt.get('prompt_id')}",
                )
                trace.finish_run("error", "命令交互提示发送失败")
                return None
            trace.finish_run("success", "已发送命令确认交互")
            return None
        await send_text(payload, cmd_reply)
        trace.finish_run("success", cmd_reply)
        return None
    if goal_start:
        # 命令已写入 session_context；本轮继续进入 runner，让 /goal 本身就开始执行。
        req.message = f"请立即开始执行目标任务：{goal_text}"

    tool_display_mode, show_intermediate_replies = await _im_display_preferences(req.user_id)
    if platform == "telegram":
        from agent.interactions.preferences import im_user_locale
        payload["locale"] = await im_user_locale(req.user_id)
    from agent.interactions.preferences import im_mermaid_theme_preferences
    payload["mermaid_theme_preferences"] = await im_mermaid_theme_preferences(req.user_id)
    bind_im_context(
        req,
        payload,
        tool_display_mode=tool_display_mode,
    )
    await remember_im_reach(user_id, platform, payload, puid)
    activity = await start_im_activity(payload, platform, puid)
    # Redis 路由 session 缓存 miss/过期时，Runner 会稍后自行从数据库复用会话；
    # 先在这里补齐 ID，才能从消息入站起向 Web 广播消息、run 状态及生成流。
    await _ensure_im_session(req)
    trace.bind_im_run(req.session_id, platform)
    # IM run 的实时镜像与持久化失败终态由 bridge 统一管理。
    stream_bridge = ImWebStreamBridge(user_id, req.session_id, platform)
    web_stream_failed = False
    await stream_bridge.begin()

    feishu_tool_summary = _create_feishu_tool_summary(
        platform,
        payload.get("chat_type"),
        tool_display_mode == "all",
    )

    shown_interaction_ids: set[int] = set()
    sent_round_indices: set[int] = set()
    immediate_round_index = 0
    immediate_round_blocked = False
    qq_private_streaming = False
    if platform == "qq" and payload.get("chat_type") == "c2c":
        message_format = payload.get("message_format")
        if message_format not in {"compat", "markdown"}:
            from agent.im.message_format import resolve_message_format
            message_format = await resolve_message_format(route.bot_id, "c2c")
        # Markdown 私聊由 QQ stream_messages 实时交付正文；被动 msg_id
        # 过期或传输失败时，流式发送器回退普通消息出口。
        qq_private_streaming = _qq_private_streaming_requested(
            platform, payload.get("chat_type"), message_format,
        )
    telegram_stream_tool_events = asyncio.Queue() if (
        platform == "telegram" and payload.get("chat_type") == "c2c"
    ) else None
    tool_event_callback = partial(
        display_tool_event,
        payload,
        tool_display_mode=tool_display_mode,
        publish_web_event=stream_bridge.publish,
        feishu_tool_summary=feishu_tool_summary,
        stream_tool_events=telegram_stream_tool_events,
    )

    async def _show_round(text: str) -> bool:
        """立即发送已结束的正文 round，成功后从最终收尾中跳过。"""
        nonlocal immediate_round_index, immediate_round_blocked
        from agent.im.replies import send_completed_round

        if not str(text or "").strip():
            return True
        await stream_bridge.publish({"type": "token", "content": str(text)})
        index = immediate_round_index
        immediate_round_index += 1
        if not show_intermediate_replies:
            return True
        # 发送失败后不能再把后续 round 当成连续前缀；最终收尾会按已成功
        # 发送的 index 精确补发，避免丢失失败 round 或重复发送成功 round。
        if immediate_round_blocked:
            return False
        sent = await send_completed_round(payload, str(text))
        if sent:
            sent_round_indices.add(index)
        else:
            immediate_round_blocked = True
        return sent

    async def _show_im_interaction(interaction: dict) -> None:
        """在共享 Runner 进入等待前发送交互，并结束 IM typing。"""
        await stream_bridge.publish({"type": "interaction_required", **interaction})
        # ask_user 会让 Runner 等待用户选择；typing 不能持续到下一条消息，
        # 但活跃状态仍需保留，便于后续回答正确路由回同一交互。
        await stop_im_typing(activity)
        try:
            sent = await _send_interaction_prompts(payload, [interaction])
        except Exception as exc:
            # 平台展示失败不能取消当前 Run；网页仍可从 active prompt 恢复交互。
            from app.core.redaction import diag_log
            diag_log("agent.im.interaction_display", exc)
            return
        if not sent:
            # 交互发送失败时不能记为已展示，否则 run 会继续等待一个用户根本看不到的提示，
            # 且收尾阶段也不会再次尝试发送。
            from app.core.redaction import diag_log_raw
            diag_log_raw(
                "agent.im.interaction_display",
                f"send_failed platform={payload.get('platform')} "
                f"chat_type={payload.get('chat_type')} prompt_id={interaction.get('prompt_id')}",
            )
            return
        prompt_id = interaction.get("prompt_id")
        if prompt_id is not None:
            shown_interaction_ids.add(int(prompt_id))

    # 飞书使用 CardKit、Telegram 私聊使用 live draft 流式预览；其余平台按 round 收集发送。
    stream_sent = False
    try:
        if platform == "feishu":
            from agent.gateway import feishu
            receive_id = payload.get("chat_id") or payload.get("platform_user_id")
            token_iter = run_stream(
                req,
                on_interaction=_show_im_interaction,
                on_tool_event=tool_event_callback,
                on_event=stream_bridge.publish,
                on_display=stream_bridge.publish_display,
            )
            stream_sent, resp = await feishu.send_text_stream(
                str(receive_id or ""), stream_bridge.mirror_stream(token_iter),
                channel_id=payload.get("channel_id"),
                tool_summary=feishu_tool_summary,
                mermaid_theme_preferences=payload.get("mermaid_theme_preferences"),
            )
            if resp is None and stream_sent:
                # 卡片已经可见但流没有产出最终响应；不能重新执行同一 Run。
                raise RuntimeError("飞书流式回复已发送卡片，但未收到最终响应")
            if resp is None:
                # 没有可用飞书凭据时，流式网关不会消费生成器；继续走统一收集出口，
                # 避免消息已入历史却没有任何回复。
                resp = await run_collect(
                    req,
                    on_interaction=_show_im_interaction,
                    on_tool_event=tool_event_callback,
                    on_display=stream_bridge.publish_display,
                    on_round=_show_round,
                )
            reply_text = ""
        elif qq_private_streaming:
            from agent.im.replies import send_qq_stream_by_round
            token_iter = run_stream(
                req,
                on_interaction=_show_im_interaction,
                on_tool_event=tool_event_callback,
                on_event=stream_bridge.publish,
                on_display=stream_bridge.publish_display,
            )
            stream_sent, resp, reply_text = await send_qq_stream_by_round(
                payload, stream_bridge.mirror_stream(token_iter),
                show_intermediate_replies=show_intermediate_replies,
            )
        elif platform == "telegram" and payload.get("chat_type") == "c2c":
            from agent.im.replies import send_telegram_stream_by_round
            token_iter = run_stream(
                req,
                on_interaction=_show_im_interaction,
                on_tool_event=tool_event_callback,
                on_event=stream_bridge.publish,
                on_display=stream_bridge.publish_display,
            )
            resp, telegram_sent_rounds = await send_telegram_stream_by_round(
                payload,
                stream_bridge.mirror_stream(token_iter, telegram_stream_tool_events),
                show_intermediate_replies=show_intermediate_replies,
            )
            sent_round_indices.update(telegram_sent_rounds)
            reply_text = ""
        else:
            resp = await run_collect(
                req,
                on_interaction=_show_im_interaction,
                on_tool_event=tool_event_callback,
                on_display=stream_bridge.publish_display,
                on_round=_show_round,
            )
            reply_text = ""
        if resp.errored:
            web_stream_failed = True
            from agent.errors import LLMErrorPresentation

            await stream_bridge.publish_failure(
                req,
                resp.error_info or LLMErrorPresentation.from_event({
                    "type": "error",
                    "message": resp.text,
                })
            )
    except BaseException as exc:
        web_stream_failed = True
        from agent.errors import describe_llm_error
        await stream_bridge.publish_failure(req, describe_llm_error(exc))
        trace.finish_run("error")
        raise
    finally:
        await finish_im_activity(activity)
        await stream_bridge.finish(failed=web_stream_failed)

    return await finalize_im_dispatch(
        payload=payload,
        request=req,
        route=route,
        session_scope=session_scope,
        response=resp,
        trace_id=trace_id,
        sent_round_indices=sent_round_indices,
        shown_interaction_ids=shown_interaction_ids,
        show_intermediate_replies=show_intermediate_replies,
        stream_sent=stream_sent,
        stream_reply_text=reply_text,
    )
