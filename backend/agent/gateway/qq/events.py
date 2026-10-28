"""QQ WebSocket 入站事件、引用、mention 与交互 ACK 适配。"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any, Dict
from uuid import UUID

from app.core import redis as R
from app.core.redaction import diag_log, redact
from agent.im.parsers.qq import (
    _contains_qq_face,
    _extract_quoted,
    _extract_qq_faces,
    _normalize_qq_faces,
    _pop_pending_qq_face,
    _queue_pending_qq_face,
    _qq_face_pending_key,
    _strip_qq_face_markers,
    _message_scene_ext,
    _scene_ext_value,
)
from agent.im.qq_ref_index import QQRefIndex, ref_index_key
from agent.im.message_format import resolve_message_format as _message_format
from agent.im.permissions import resolve_group_policy as _group_settings
from .client import _qq_request
from .outbound import _post, _post_group

_log = logging.getLogger("agent.gateway.qq")

STREAM = R.IM_INBOUND_STREAM

_ACK_COOLDOWN = 10.0   # 同一用户「文件收到啦」秒回的冷却秒数：连发多图/文件只 ack 一次，不刷屏

_ref_indexes: dict[tuple[str, str], QQRefIndex] = {}

def _qq_ref_index(owner: str, channel_id: str) -> QQRefIndex:
    key = (owner, channel_id)
    index = _ref_indexes.get(key)
    if index is None:
        index = QQRefIndex(owner=owner, bot_id=channel_id)
        _ref_indexes[key] = index
    return index

def _qq_message_index_key(data: Dict[str, Any], chat_type: str, chat_id: str, sender_id: str) -> str:
    ext = _message_scene_ext(data)
    msg_idx = _scene_ext_value(ext, "msg_idx")
    return msg_idx or str(data.get("id") or "")

def _remember_qq_message(index: QQRefIndex, data: Dict[str, Any], chat_type: str,
                         chat_id: str, sender_id: str, sender_name: str) -> None:
    msg_key = _qq_message_index_key(data, chat_type, chat_id, sender_id)
    if not msg_key:
        return
    attachments = data.get("attachments") or []
    if not isinstance(attachments, list):
        attachments = []
    compact_attachments = []
    for item in attachments:
        if not isinstance(item, dict):
            continue
        compact_attachments.append({
            key: item[key]
            for key in ("url", "filename", "content_type", "file_url", "download_url")
            if item.get(key)
        })
    index.set(ref_index_key(chat_type, chat_id, sender_id, msg_key), {
        "message_id": str(data.get("id") or ""),
        "sender_id": sender_id,
        "sender_name": sender_name,
        "content": str(data.get("content") or "")[:200],
        "attachments": compact_attachments,
        "timestamp": str(data.get("timestamp") or ""),
    })

def _quoted_from_index(index: QQRefIndex, data: Dict[str, Any], chat_type: str,
                      chat_id: str, sender_id: str) -> tuple[str, list]:
    ref_idx = _scene_ext_value(_message_scene_ext(data), "ref_msg_idx")
    if not ref_idx:
        return "", []
    entry = index.get(ref_index_key(chat_type, chat_id, sender_id, ref_idx))
    if not entry:
        return "", []
    return str(entry.get("content") or ""), list(entry.get("attachments") or [])

def _quoted_platform_message_id(data: Dict[str, Any]) -> str:
    """提取引用目标的稳定 QQ 消息标识，不使用签名下载 URL。"""
    return str(_scene_ext_value(_message_scene_ext(data), "ref_msg_idx") or "")

def _qq_message_mentions_bot(data: Dict[str, Any], event_type: str) -> bool:
    """只有 QQ 明确标记属于当前实例的 mention 才算 @ 到本机器人。

    同群多个机器人都会收到 AT 事件；事件类型或 ``bot=True`` 只能说明目标
    是某个机器人，不能证明目标是当前实例。缺少 ``is_you`` 时保守按未命中处理。
    """
    if event_type not in {"GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"}:
        return False
    mentions = data.get("mentions")
    if not isinstance(mentions, list):
        return False
    for item in mentions:
        if (
            isinstance(item, dict)
            and item.get("bot") is True
            and item.get("is_you") is True
        ):
            return True
    return False

def _qq_bot_mention_id(data: Dict[str, Any], event_type: str) -> str:
    """只提取 QQ 明确标记为当前实例的 bot ID，供咕咕身份展示使用。"""
    if event_type not in {"GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"}:
        return ""
    mentions = data.get("mentions")
    if isinstance(mentions, list):
        for item in mentions:
            if (
                not isinstance(item, dict)
                or item.get("bot") is not True
                or item.get("is_you") is not True
            ):
                continue
            for key in ("id", "user_openid", "member_openid", "openid"):
                value = item.get(key)
                if value:
                    return str(value)
    return ""


def _qq_message_mentions_other_bot(data: Dict[str, Any]) -> bool:
    """判断消息是否 @ 了别的 bot（同一个群里还有别的机器人在）。

    QQ 的 mention 条目带 ``bot`` 标记：``bot=True`` 且 ``is_you`` 不为 True
    就是 @ 别人家的机器人。这种消息不是喊咕咕的，抢答会替别人作答。
    """
    mentions = data.get("mentions")
    if not isinstance(mentions, list):
        return False
    for item in mentions:
        if not isinstance(item, dict) or item.get("bot") is not True:
            continue
        if item.get("is_you") is True:
            continue
        return True
    return False

async def _qq_reply(channel_id: str, chat_type: str, target_id: str, text: str, msg_id: str | None) -> None:
    try:
        message_format = await _message_format(channel_id, chat_type)
        if chat_type == "group":
            await _post_group(channel_id, target_id, text, msg_id, message_format)
        else:
            await _post(channel_id, target_id, text, msg_id, message_format)
    except Exception as e:
        # best-effort：这里只发网关侧必须立刻返回的答复（附件「收到啦」秒回提示、
        # 取消/绑定确认）；失败不影响正式回复走 worker 那条主链路，可以广吞，
        # 但仍要留痕方便排查。
        diag_log("agent.gateway.qq._qq_reply", e)
        _log.warning("[qq] 即时回复失败: %s", redact(f"{type(e).__name__}: {e}"))

async def _ack_qq_interaction(channel_id: str, interaction_id: str, *, code: int = 0) -> bool:
    """确认 QQ Keyboard interaction，避免客户端在业务处理后继续显示 loading。

    这和发送“已选择”文本是两条独立链路：前者是 QQ 回调协议 ACK，使用
    code=0 表示服务端已经消费成功；后者只是用户可见的状态提示。
    """
    if not interaction_id:
        return False
    try:
        await _qq_request(
            channel_id,
            "PUT",
            f"/interactions/{interaction_id}",
            json_body={"code": int(code)},
        )
        return True
    except Exception as exc:
        diag_log("agent.gateway.qq.interaction_ack", exc)
        return False

async def _handle_raw_qq_message(event_type: str, data: Dict[str, Any],
                                 channel_id: str, owner: str, last_ack: dict) -> None:
    read_enabled = False
    group_memory_enabled = True
    member_memory_enabled = True
    mentioned = False
    if event_type == "C2C_MESSAGE_CREATE":
        chat_type = "c2c"
        author = data.get("author") or {}
        sender_id = author.get("user_openid") or author.get("id") or ""
        sender_name = str(author.get("username") or author.get("nickname") or "").strip()
        chat_id = ""
    elif event_type in {"GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"}:
        group_settings = await _group_settings(channel_id)
        group_enabled, requires_at = group_settings[:2]
        # 兼容旧的测试/自定义适配器返回短元组；新增记忆字段缺失时保持开启。
        read_enabled = bool(group_settings[2]) if len(group_settings) > 2 else False
        group_memory_enabled = bool(group_settings[3]) if len(group_settings) > 3 else True
        member_memory_enabled = bool(group_settings[4]) if len(group_settings) > 4 else True
        mentioned = _qq_message_mentions_bot(data, event_type)
        if not group_enabled:
            return
        # QQ 平台的机器人权限决定网关能否收到全量群消息；平台层不再按回应方式
        # 过滤事件。非 @ 消息是否只记录、不回复，由 IM Loop 统一决定。
        chat_type = "group"
        author = data.get("author") or {}
        # QQ 群事件在新协议里可能同时提供 user_openid 与 member_openid。
        # 绑定验证码使用 C2C 的 user_openid，优先采用同一字段才能让 owner
        # 在私聊绑定后在群里 @ 咕咕时仍解析为 owner；旧事件没有它时再退回 member_openid。
        sender_id = author.get("user_openid") or author.get("member_openid") or author.get("id") or ""
        sender_name = str(author.get("username") or author.get("nickname") or "").strip()
        chat_id = data.get("group_openid") or ""
    else:
        return
    if not sender_id:
        return
    bot_platform_user_id = _qq_bot_mention_id(data, event_type)
    # @ 的是别的 bot 时，咕咕不该抢答：这条消息是喊别人家的机器人的。
    mentions_other_bot = _qq_message_mentions_other_bot(data)
    # 成员 mention 保留原始 ID；展示层按会话内最新 username 解析，避免改名后被旧昵称冻结。
    raw_text = (data.get("content") or "").strip()
    from agent.security import logsafe
    has_qq_face = _contains_qq_face(raw_text)
    face_ids = _extract_qq_faces(raw_text)
    # QQ 经常把一个表情拆成「协议文本」和紧随其后的图片事件；协议文本本身不应成为
    # 一条独立聊天消息，也不应和图片同时显示成两个内容块。
    face_only = has_qq_face and not _strip_qq_face_markers(raw_text)
    text = _normalize_qq_faces(raw_text)
    msg_id = data.get("id") or ""
    # 在引用解析、附件 staging 和绑定码/快捷命令处理前检查安全输入态；
    # 凭据消息不应触发任何普通消息副作用。
    from agent.im.interaction_text import consume_mcp_secret_payload

    if await consume_mcp_secret_payload({
        "platform": "qq", "channel_id": channel_id, "owner_user_id": owner,
        "platform_user_id": sender_id, "message_id": msg_id,
        "chat_type": chat_type, "chat_id": chat_id or None,
        "text": text, "attachments": data.get("attachments") or [],
        "emoji_refs": face_ids if face_only else [],
    }):
        return
    if chat_type == "c2c":
        # QQ 扫码连接只返回 Bot 凭据，不返回当前私聊用户的 openid。
        # 首次私聊作为 owner 身份来源，后续群聊权限再复用这个绑定结果。
        from app.services.im_identity import bind_qq_owner_if_unbound

        try:
            await bind_qq_owner_if_unbound(int(channel_id), UUID(str(owner)), sender_id)
        except Exception as exc:
            diag_log("agent.gateway.qq.auto_owner_binding", exc)
        # 验证码本身已足够定位绑定任务，不要求用户输入某种语言的命令词。
        # 保留旧格式兼容，新的交互只需直接发送 6 位数字。
        binding_match = re.fullmatch(r"(?:绑定\s*|bind\s*)?([0-9]{6})", text, flags=re.IGNORECASE)
        if binding_match:
            from app.services.im_identity import consume_qq_binding_code

            try:
                bound = await consume_qq_binding_code(
                    int(channel_id), UUID(str(owner)), sender_id, binding_match.group(1)
                )
            except Exception as exc:
                diag_log("agent.gateway.qq.binding_code", exc)
                bound = False
            reply = "QQ 身份已绑定，之后可以正常使用。" if bound else "验证码无效或已过期，请回网页重新生成。"
            await _qq_reply(channel_id, chat_type, sender_id, reply, msg_id)
            return
    raw_attachments = data.get("attachments") or []
    if not isinstance(raw_attachments, list):
        raw_attachments = []
    ref_index = _qq_ref_index(owner, channel_id)
    # 先登记当前消息，再解析引用；这样同一条消息的 msg_idx 可以被后续私聊/群聊引用复用。
    _remember_qq_message(ref_index, data, chat_type, chat_id, sender_id, sender_name)
    # 引用原文单独存 quoted_text，不拼进 text——runner.py 只把它喂给模型当上下文，
    # ConversationMessage.content/网页展示仍是用户自己打的话，别再把引用原文拼进正文
    # （网页气泡纯文本渲染，拼进去会把引用的 markdown 原样摊平显示得很难看，见 devlog 2026-07-10）。
    quoted_text, quoted_attachments = _extract_quoted(data)
    if not quoted_text and not quoted_attachments:
        quoted_text, quoted_attachments = _quoted_from_index(
            ref_index, data, chat_type, chat_id, sender_id,
        )
    quoted_text = _normalize_qq_faces(quoted_text)
    if quoted_attachments and quoted_text == "[QQ表情]":
        quoted_text = ""
    if quoted_attachments:
        quoted_source_id = _quoted_platform_message_id(data)
        quoted_attachments = [
            dict(
                item,
                quoted=True,
                source_platform_message_id=quoted_source_id or item.get("source_platform_message_id"),
                source_attachment_index=index,
            )
            for index, item in enumerate(quoted_attachments)
        ]
    all_attachments = raw_attachments + quoted_attachments
    face_key = _qq_face_pending_key(chat_type, chat_id, sender_id)
    now = time.monotonic()
    pending_face_ids = []
    pending_face = not has_qq_face and bool(raw_attachments)
    if pending_face:
        pending_face_ids = _pop_pending_qq_face(face_key, now)
        pending_face = bool(pending_face_ids)
    # 收藏表情（faceType=6）仍可能先到协议文本、后到图片事件；只对这一类保留
    # 原有的短暂等待。系统表情/表情商店没有后续图片事件，必须把协议文本入队，
    # 否则 GuguChat 和群上下文都会丢掉这条消息。
    wait_for_split_face = bool(face_ids) and all(item.get("face_type") == "6" for item in face_ids)
    if face_only and not all_attachments and not quoted_text and not quoted_attachments and wait_for_split_face:
        _queue_pending_qq_face(face_key, face_ids, now)
        # 等下一条图片事件到达，再以一条「图片表情消息」入队。
        return
    if has_qq_face or pending_face:
        all_attachments = [
            dict(item, qq_face=True)
            if isinstance(item, dict) and not item.get("quoted")
            else item
            for item in all_attachments
        ]
    if has_qq_face and all_attachments:
        text = _normalize_qq_faces(_strip_qq_face_markers(raw_text))
    if pending_face:
        text = ""
    # 资源提供器只负责补图，不能让资源未命中把整条表情消息变成空消息。
    # 没有附件且 ext.text 为空时，保留稳定的历史占位文本，供 GuguChat 和群上下文展示。
    if face_only and not all_attachments and not text.strip():
        text = "[QQ表情]"
    if all_attachments:
        ack_target = chat_id if chat_type == "group" else sender_id
        now = time.monotonic()
        ack_key = f"{chat_type}:{ack_target}"
        # 附件确认也属于对外回复：自动回复模式下的普通群消息必须先经过
        # Agent 选择门；只有明确 @ 咕咕时才能在模型选择前发送确认。
        should_reply = (
            chat_type != "group"
            or (
                not read_enabled
                and mentioned
            )
        )
        if should_reply and now - last_ack.get(ack_key, 0.0) > _ACK_COOLDOWN:
            last_ack[ack_key] = now
            await _qq_reply(channel_id, chat_type, ack_target, "文件收到啦，让我看看~", msg_id)
    if not text and not all_attachments and not quoted_text:
        return
    from agent.runtime import trace
    tid = trace.new_trace()
    payload = {
        "platform": "qq",
        "channel_id": channel_id,
        "owner_user_id": owner,
        "platform_user_id": sender_id,
        "platform_user_name": sender_name or None,
        "platform_bot_user_id": bot_platform_user_id or None,
        "message_id": msg_id,
        "platform_message_id": _qq_message_index_key(data, chat_type, chat_id, sender_id),
        "chat_type": chat_type,
        "text": text,
        "quoted_text": quoted_text or None,
        "attachments": all_attachments,
        "emoji_refs": face_ids if face_only else [],
        "qq_face_marker": has_qq_face,
        "trace_id": tid,
    }
    if chat_type == "group":
        payload["chat_id"] = chat_id
        payload["group_requires_at"] = requires_at
        payload["group_read_enabled"] = read_enabled
        payload["group_memory_enabled"] = group_memory_enabled
        payload["member_memory_enabled"] = member_memory_enabled
        payload["group_mentioned"] = mentioned
        payload["bot_mentioned"] = mentioned
        payload["mentions_other_bot"] = mentions_other_bot
    payload["message_format"] = await _message_format(channel_id, chat_type)
    from agent.security import logsafe
    channel_fp = logsafe.fingerprint(channel_id)
    sender_fp = logsafe.fingerprint(sender_id)
    if chat_type == "group":
        print(f"[qq:{channel_fp}] 收到群 {logsafe.fingerprint(chat_id)} 内 {sender_fp}: text_len={len(text)} "
              f"fp={logsafe.fingerprint(text)} att={len(all_attachments)} trace={tid}", flush=True)
    else:
        print(f"[qq:{channel_fp}] 收到 {sender_fp}: text_len={len(text)} "
              f"fp={logsafe.fingerprint(text)} att={len(all_attachments)} trace={tid}", flush=True)

    # 取消是实时控制信号：必须在 Gateway 侧立刻写入 Redis，不能等同用户锁的
    # worker 轮到这条消息；普通 reply/drop shortcut 仍交给 worker 决策。
    if not all_attachments:
        from agent.im.shortcuts import apply_im_shortcut_cancel, decide_im_shortcut
        dec = await decide_im_shortcut(
            "qq", sender_id, text,
            bot_id=channel_id,
            scope_id=chat_id or sender_id,
            allow_leading_mention=chat_type == "group" and mentioned,
        )
        if dec["action"] == "cancel":
            await apply_im_shortcut_cancel(
                "qq", sender_id, dec,
                bot_id=channel_id,
                scope_id=chat_id or sender_id,
            )
            target = chat_id if chat_type == "group" else sender_id
            await _qq_reply(channel_id, chat_type, target, dec["reply"], msg_id)
            return
        if dec["action"] == "no_permission":
            # 咕咕在跑别人的 loop，当前用户无权取消：回一句提示，不写取消标志、不入队。
            target = chat_id if chat_type == "group" else sender_id
            await _qq_reply(channel_id, chat_type, target, dec["reply"], msg_id)
            return

    try:
        await R.produce(STREAM, payload)
    except Exception as e:
        # 入队失败＝这条用户消息会被丢——不是无关紧要的 best-effort，值得响亮记录（受限出口留原始，
        # 可见日志留脱敏摘要），但不重试：Redis 层面的问题重试一次大概率还是失败，且这里已经是
        # 网关事件回调里，没有把整条 WS 消息回放重放的机制，重试意义不大，交给运维看诊断日志处理。
        diag_log("agent.gateway.qq._handle_raw_qq_message.enqueue", e)
        _log.error("[qq] 入队失败: %s", redact(f"{type(e).__name__}: {e}"))

async def _handle_qq_interaction(data: Dict[str, Any], channel_id: str, owner: str) -> None:
    """消费 QQ Keyboard 回调，并以受控文本恢复原会话。"""
    raw_data = data.get("data") if isinstance(data.get("data"), dict) else {}
    interaction_id = str(data.get("id") or raw_data.get("id") or "")
    from agent.interactions.qq import parse_interaction_event
    event = parse_interaction_event(data)
    if event is None or not event.get("platform_user_id"):
        await _ack_qq_interaction(channel_id, interaction_id, code=1)
        return
    try:
        from app.db import session as db_session
        from app.services.interactions import consume_action
        from app.services.mcp_secret_inputs import consume_mcp_secret_action
        db_session.ensure_engine()
        if db_session._SessionLocal is None:
            return
        result = None
        async with db_session._SessionLocal() as db:
            user_id = UUID(str(owner))
            result = await consume_mcp_secret_action(
                db, user_id=user_id, prompt_id=event["prompt_id"], token=event["token"],
                event_id=str(event.get("event_id") or ""), platform="qq", bot_id=channel_id,
                platform_user_id=str(event["platform_user_id"]),
                chat_type=str(event.get("chat_type") or "c2c"),
                chat_id=event.get("chat_id"),
            )
            if result is None:
                result = await consume_action(
                    db, user_id=user_id, prompt_id=event["prompt_id"], token=event["token"],
                    event_id=event.get("event_id"),
                )
    except (LookupError, ValueError):
        await _ack_qq_interaction(channel_id, interaction_id, code=3)
        # 交互回调的 event_id 不是 QQ 消息 msg_id，不能用于消息回复，否则会触发
        # 40034024（msg_id 无效或越权）。交互状态已经由上面的协议 ACK 确认，
        # 这里发送独立的提示；如果按钮来自群聊，必须回到原群，不能误发到私聊。
        error_chat_type = str(event.get("chat_type") or "c2c")
        error_target_id = (
            event.get("chat_id")
            if error_chat_type == "group" and event.get("chat_id")
            else event["platform_user_id"]
        )
        await _qq_reply(
            channel_id, error_chat_type, error_target_id,
            "这个操作已过期或已经处理过了。", None,
        )
        return
    except Exception as exc:
        await _ack_qq_interaction(channel_id, interaction_id, code=1)
        diag_log("agent.gateway.qq.interaction", exc)
        return
    await _ack_qq_interaction(channel_id, interaction_id, code=0)

    option_id = str(result.get("option_id") or "")
    result_payload = result.get("result") if isinstance(result.get("result"), dict) else {}
    selected_text = str(result_payload.get("text") or option_id)
    chat_type = str(event.get("chat_type") or "c2c")
    target_id = event.get("chat_id") or event["platform_user_id"]
    if result_payload.get("status") == "awaiting_text":
        await _qq_reply(
            channel_id, chat_type, target_id,
            "请直接发送你的回复，咕咕会继续处理。", None,
        )
        return
    if result.get("status") == "awaiting_secret":
        await _qq_reply(channel_id, chat_type, target_id, "请发送凭据字段值；取消输入请发送“取消”。", None)
        return
    if result.get("status") == "cancelled" and result.get("prompt_id"):
        await _qq_reply(channel_id, chat_type, target_id, "已取消凭据输入。", None)
        return
    await _qq_reply(
        channel_id,
        chat_type,
        target_id,
        (
            "已确认，任务继续执行。" if option_id == "confirm"
            else "已取消。" if option_id == "cancel"
            else f"已选择：{selected_text}，继续处理。"
        ),
        None,
    )
