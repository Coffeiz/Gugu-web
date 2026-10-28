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
        if response.remote_status_unknown:
            await send_text(payload, "本地已停止，远端执行状态未知")
        await finalize_im_response(platform, puid, True, "")
        return response

    if getattr(request, "group_auto_reply", False):
        from agent.im.auto_reply import ReplyChoice

        gate = getattr(request, "group_reply_gate", None)
        gate_opened = gate is not None and gate.choice is ReplyChoice.REPLY
        if not gate_opened:
            # 回复门关闭期间群里不得出现任何可见内容（PRD-IM-16 §6）：
            # - 未选择 / 选择不回复 → 空正文，普通 IM 收尾会回退成「嗯~在的」，必须彻底静默
            # - 协议失败 / 模型失败 → 保留 errored 终态与受限诊断（网页流、run outcome、日志），
            #   但错误文案只是内部诊断，不得当回复发进群；否则群成员会看到本轮不该出现的提示。
            trace.finish_run("error" if response.errored else "success")
            await finalize_im_response(platform, puid, False, "")
            return response

    # 工具状态消息仍受工具展示模式控制；交互提示是恢复 Runner 所必需
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

    if platform == "qq":
        # 流式发送器已经完整交付正文时，只收尾附件，避免再发一份重复最终消息。
        # 未流式发送的最终回复保留入站 msg_id：网关先发被动消息，失败时再主动重试。
        if stream_reply_text is None:
            # 流已确认发送最终正文前缀，但尾部恢复失败；重发全文会重复前缀，
            # 因此将 Run 标记为交付失败，不再盲目重发。
            reply_text = None
        else:
            # 已由 QQ 私聊流式接口交付的正文不能再走被动出口；未流式正文应优先
            # 关联入站消息发送，send_c2c/send_group 会在被动发送失败时主动回退。
            final_payload = {**payload, "message_id": None} if stream_sent else payload
            reply_text = await send_agent_response(
                final_payload, response,
                already_sent_rounds=(
                    1 if payload.get("chat_type") == "c2c" and stream_sent and not response.errored else 0
                ),
                show_intermediate_replies=False,
            )
            # QQ 私聊流式发送时，正文只存在 stream_reply_text；response.text 和
            # round_texts 可能为空。send_agent_response 因为该轮已发送会返回空串，
            # 这里用实际流式正文补齐 run 终态与活动记录，不重复发送消息。
            if not response.errored and stream_sent and stream_reply_text and not reply_text:
                reply_text = stream_reply_text
    elif platform == "feishu" and stream_sent:
        # CardKit 已经发送正文；附件仍由统一附件出口发送，避免文本重复。
        if response.files:
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
