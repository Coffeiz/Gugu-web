"""IM run 完成后的会话写回、记忆触发和平台回复收尾。"""
from __future__ import annotations

import asyncio
import re
import time

from agent.im.activity import finalize_im_response
from agent.im.conversation import persist_im_session
from agent.im.presentation import _send_interaction_prompts
from agent.im.request_preparation import _should_observe_private_member_activity
from agent.im.replies import send_agent_response, send_text
from agent.runtime import trace
from agent.security import logsafe

_SOFT_MATERIAL_REQUEST_RE = re.compile(
    r"(?:截图|图片|照片|文件|日志|报错|结果|录屏|样例).{0,24}(?:发|上传|贴|提供|补充)|"
    r"(?:发|上传|贴|提供|补充).{0,24}(?:截图|图片|照片|文件|日志|报错|结果|录屏|样例)"
)


async def _register_soft_request_anchor(payload: dict, text: str, *, run_key: str | None) -> None:
    if (
        payload.get("chat_type") != "group"
        or payload.get("group_attention_mode") not in {"natural", "active"}
        or not payload.get("platform_user_id")
        or not text
        or not _SOFT_MATERIAL_REQUEST_RE.search(text)
    ):
        return
    from app.core import redis as R
    from agent.im.auto_reply.budget import register_soft_anchor

    anchor_id = str(run_key or payload.get("event_id") or "")
    try:
        await register_soft_anchor(
            R.get_redis(),
            platform=str(payload.get("platform") or ""),
            bot_id=str(payload.get("channel_id") or payload.get("bot_id") or ""),
            group_id=str(payload.get("chat_id") or ""),
            sender_id=str(payload.get("platform_user_id") or ""),
            anchor_id=anchor_id,
        )
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.attention.soft_anchor", exc)


async def _settle_attention_budget(request, *, outcome: str) -> None:
    reservation = getattr(request, "attention_budget_reservation", None)
    heartbeat = getattr(request, "attention_budget_heartbeat", None)
    if heartbeat is not None:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
        request.attention_budget_heartbeat = None
    if not reservation:
        return
    from app.core import redis as R
    from agent.im.auto_reply.budget import settle_proactive_slot, settle_soft_slot

    try:
        now_ms = int(time.time() * 1000)
        redis = R.get_redis()
        # 当前平台出口没有跨平台消息查询对账接口。回执不明时将其记为
        # UNRESOLVED，并在 10 分钟预算窗内保守占位；不自动重发。
        settled_outcome = "UNRESOLVED" if outcome == "UNKNOWN" else outcome
        if reservation.get("kind") == "soft":
            await settle_soft_slot(
                redis,
                platform=reservation["platform"],
                bot_id=reservation["bot_id"],
                group_id=reservation["group_id"],
                sender_id=reservation["sender_id"],
                run_id=reservation["run_id"],
                outcome=settled_outcome,
                now_ms=now_ms,
            )
        else:
            await settle_proactive_slot(
                redis,
                platform=reservation["platform"],
                bot_id=reservation["bot_id"],
                group_id=reservation["group_id"],
                run_id=reservation["run_id"],
                outcome=settled_outcome,
                now_ms=now_ms,
            )
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.attention.budget_release", exc)


def _verified_budget_outcome(payload: dict, fallback: str) -> str:
    """tracked 模式只按真实出站回执提交额度，正文存在不等于平台接受。"""
    if payload.get("_attention_track_delivery") is not True:
        return fallback
    receipts = payload.get("_attention_outbound_receipts") or []
    statuses = [item.get("status") for item in receipts if isinstance(item, dict)]
    if "ACCEPTED" in statuses:
        return "ACCEPTED"
    if any(status not in {"FAILED_CONFIRMED", "RELEASED"} for status in statuses):
        return "UNKNOWN"
    if statuses:
        return "FAILED_CONFIRMED"
    return "FAILED_CONFIRMED" if fallback == "FAILED_CONFIRMED" else "UNKNOWN"


def _log_attention_run_outcome(
    payload: dict,
    request,
    *,
    run_outcome: str,
    reply_sent: bool = False,
) -> None:
    """记录真实 Run 收尾事实；不写入正文、群 ID 或成员身份。"""
    if payload.get("_attention_audit_enabled") is not True:
        return
    import json

    from agent.im.auto_reply import ReplyChoice
    from app.core.redaction import diag_log_raw

    gate = getattr(request, "group_reply_gate", None)
    receipts = payload.get("_attention_outbound_receipts") or []
    receipt_statuses = [
        item.get("status") for item in receipts if isinstance(item, dict)
    ]
    if receipt_statuses:
        if "ACCEPTED" in receipt_statuses:
            outbound_status = "ACCEPTED"
        elif any(status not in {"FAILED_CONFIRMED", "RELEASED"} for status in receipt_statuses):
            outbound_status = "UNKNOWN"
        else:
            outbound_status = "FAILED_CONFIRMED"
    elif reply_sent:
        outbound_status = "ACCEPTED"
    else:
        outbound_status = None

    diag_log_raw(
        "agent.im.attention.run_outcome",
        json.dumps({
            "attention_version": "attention-v1.4",
            "mode": str(payload.get("group_attention_mode") or "autonomous"),
            "config_version": int(payload.get("_attention_config_version") or 0),
            "run_entered": True,
            "choose_no_reply_used": bool(
                gate is not None and gate.choice is ReplyChoice.SILENT
            ),
            "run_outcome": run_outcome,
            "outbound_status": outbound_status,
            "outbound_receipt_count": len(receipt_statuses),
        }, ensure_ascii=False, separators=(",", ":")),
    )


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
        await _settle_attention_budget(
            request,
            outcome=_verified_budget_outcome(
                payload,
                "UNKNOWN" if response.remote_status_unknown else "FAILED_CONFIRMED",
            ),
        )
        trace.finish_run("cancelled")
        if response.remote_status_unknown:
            await send_text(payload, "本地已停止，远端执行状态未知")
        await finalize_im_response(platform, puid, True, "")
        _log_attention_run_outcome(
            payload, request, run_outcome="cancelled",
        )
        return response

    if getattr(request, "group_auto_reply", False):
        from agent.im.auto_reply import ReplyChoice

        gate = getattr(request, "group_reply_gate", None)
        gate_opened = gate is not None and gate.choice is ReplyChoice.REPLY
        if not gate_opened:
            # 没有正文或选择不回复都保持群内静默；普通 IM 收尾的空正文兜底
            # （「嗯~在的」）不能用于自动回复模式。
            trace.finish_run("error" if response.errored else "success")
            await _settle_attention_budget(
                request, outcome=_verified_budget_outcome(payload, "FAILED_CONFIRMED"),
            )
            await finalize_im_response(platform, puid, False, "")
            _log_attention_run_outcome(
                payload, request,
                run_outcome="error" if response.errored else "silent",
            )
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
                await _settle_attention_budget(
                    request, outcome=_verified_budget_outcome(payload, "UNKNOWN"),
                )
                trace.finish_run("error")
                await finalize_im_response(platform, puid, False, "")
                _log_attention_run_outcome(
                    payload, request, run_outcome="attachment_delivery_failed",
                )
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
        # API 回执未知时保留主动额度，避免超额重试。
        await _settle_attention_budget(
            request, outcome=_verified_budget_outcome(payload, "UNKNOWN"),
        )
        trace.finish_run("error")
        await finalize_im_response(platform, puid, False, "")
        print(
            f"[im-loop] {platform} 回复发送失败(session={response.session_id} trace={trace_id})",
            flush=True,
        )
        _log_attention_run_outcome(
            payload, request, run_outcome="outbound_failed_or_unknown",
        )
        return response

    if response.errored:
        # 错误提示已送达，但 Agent run 仍是失败终态。
        await _settle_attention_budget(
            request,
            outcome=_verified_budget_outcome(
                payload,
                "ACCEPTED" if reply_text or response.files or sent_round_indices else "FAILED_CONFIRMED",
            ),
        )
        trace.finish_run("error", reply_text)
        await finalize_im_response(platform, puid, False, reply_text)
        print(
            f"[im-loop] {platform} 已发送失败提示(session={response.session_id} trace={trace_id}) "
            f"len={len(reply_text)} fp={logsafe.fingerprint(reply_text)}",
            flush=True,
        )
        _log_attention_run_outcome(
            payload, request, run_outcome="agent_error",
            reply_sent=bool(reply_text or response.files or sent_round_indices),
        )
        return response

    trace_output = "\n\n".join(
        str(text).strip()
        for text in (response.round_texts or [])
        if str(text or "").strip()
    ) or reply_text
    await _settle_attention_budget(
        request,
        outcome=_verified_budget_outcome(
            payload,
            "ACCEPTED" if reply_text or response.files or sent_round_indices else "FAILED_CONFIRMED",
        ),
    )
    if reply_text:
        await _register_soft_request_anchor(
            payload, reply_text, run_key=getattr(request, "inbound_batch_key", None),
        )
    trace.finish_run("success", trace_output)
    await finalize_im_response(platform, puid, False, reply_text)
    print(
        f"[im-loop] {platform} 回复(session={response.session_id} trace={trace_id}) "
        f"len={len(reply_text)} fp={logsafe.fingerprint(reply_text)}",
        flush=True,
    )
    _log_attention_run_outcome(
        payload, request, run_outcome="success",
        reply_sent=bool(reply_text or response.files or sent_round_indices),
    )
    return response
