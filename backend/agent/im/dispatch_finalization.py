"""IM run 完成后的会话写回、记忆触发和平台回复收尾。"""
from __future__ import annotations

from agent.im.activity import finalize_im_response
from agent.im.conversation import persist_im_session
from agent.im.presentation import _send_interaction_prompts
from agent.im.request_preparation import _should_observe_private_member_activity
from agent.im.replies import send_agent_response, send_text
from agent.runtime import trace
from agent.security import logsafe


async def finalize_im_dispatch(
    *,
    payload: dict,
    request,
    route,
    session_scope: str,
    response,
    trace_id: str,
    sent_round_indices: set[int],
    shown_interaction_ids: set[int],
    show_intermediate_replies: bool,
    stream_sent: bool,
    stream_reply_text: str,
):
    """写回会话、调度记忆活动并确保平台收到正确的最终消息。"""
    platform = request.source
    puid = request.platform_user_id

    await persist_im_session(
        platform,
        route.bot_id,
        session_scope,
        response.session_id,
        group=bool(payload.get("chat_type") == "group"),
    )
    if request.chat_id and response.session_id:
        try:
            from agent.memory.reflection_jobs import observe_session_activity
            from agent.memory.scopes import MemoryScope

            if request.im_group_memory_enabled:
                await observe_session_activity(
                    MemoryScope(
                        request.user_id,
                        request.source or "qq",
                        str(request.platform_bot_id or ""),
                        "group",
                        str(request.chat_id),
                    ),
                    response.session_id,
                    member_batch=False,
                )
        except Exception:
            # 记忆调度失败不影响当前回复已经完成。
            pass
    if response.session_id and _should_observe_private_member_activity(request):
        try:
            from agent.memory.reflection_jobs import observe_private_member_activity
            from agent.memory.scopes import MemoryScope

            await observe_private_member_activity(
                MemoryScope(
                    request.user_id,
                    request.source or "qq",
                    str(request.platform_bot_id or ""),
                    "platform-user",
                    str(request.platform_user_id),
                ),
                response.session_id,
                str(request.platform_user_id),
            )
        except Exception:
            # 私聊成员记忆是后台增强能力，不影响当前回复。
            pass
    if response.cancelled:
        trace.finish_run("cancelled")
        await finalize_im_response(platform, puid, True, "")
        return response

    # 工具状态消息仍受 show_tool_interactions 控制；交互提示是恢复 Runner 所必需
    # 的用户输入，不能因关闭工具状态展示而被吞掉。
    if response.interactions:
        pending_interactions = [
            item for item in response.interactions
            if item.get("prompt_id") not in shown_interaction_ids
        ]
        if pending_interactions:
            sent = await _send_interaction_prompts(payload, pending_interactions)
            if not sent:
                from app.core.redaction import diag_log_raw

                diag_log_raw(
                    "agent.im.interaction_display.final_retry",
                    f"send_failed platform={platform} chat_type={payload.get('chat_type')} "
                    f"count={len(pending_interactions)}",
                )

    if platform in {"feishu", "qq"} and stream_sent:
        # CardKit 已经发送正文；附件仍由统一附件出口发送，避免文本重复。
        if platform == "qq" and response.errored:
            # QQ token 流不承载 error 事件；部分正文已流出时仍需另发错误提示。
            reply_text = stream_reply_text if await send_text(payload, stream_reply_text) else None
        elif response.files:
            from agent.im.files import send_files

            file_result = await send_files(payload, response.files)
            reply_text = response.text or "给你～"
            if file_result.failed:
                notice = file_result.reason or "附件没有成功发出，你可以去网页或文件库查看。"
                notice_sent = await send_text(payload, notice)
                if not notice_sent:
                    from app.core.redaction import diag_log_raw

                    diag_log_raw(
                        "agent.im.file_attachment_delivery",
                        f"platform={platform} status=notice_failed",
                    )
                trace.finish_run("error")
                await finalize_im_response(platform, puid, False, "")
                return response
        else:
            reply_text = stream_reply_text or ""
    else:
        reply_text = await send_agent_response(
            payload,
            response,
            already_sent_rounds=sent_round_indices,
            show_intermediate_replies=show_intermediate_replies,
        )

    if reply_text is None:
        # 平台发送失败不能被记成成功回复。
        trace.finish_run("error")
        await finalize_im_response(platform, puid, False, "")
        print(
            f"[im-loop] {platform} 回复发送失败(session={response.session_id} trace={trace_id})",
            flush=True,
        )
        return response

    if response.errored:
        # 错误提示已送达，但 Agent run 仍是失败终态。
        trace.finish_run("error", reply_text)
        await finalize_im_response(platform, puid, False, reply_text)
        print(
            f"[im-loop] {platform} 已发送失败提示(session={response.session_id} trace={trace_id}) "
            f"len={len(reply_text)} fp={logsafe.fingerprint(reply_text)}",
            flush=True,
        )
        return response

    trace_output = "\n\n".join(
        str(text).strip()
        for text in (response.round_texts or [])
        if str(text or "").strip()
    ) or reply_text
    trace.finish_run("success", trace_output)
    await finalize_im_response(platform, puid, False, reply_text)
    print(
        f"[im-loop] {platform} 回复(session={response.session_id} trace={trace_id}) "
        f"len={len(reply_text)} fp={logsafe.fingerprint(reply_text)}",
        flush=True,
    )
    return response
