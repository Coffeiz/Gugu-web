"""QQ 官方机器人网关（单聊 C2C + 群聊，BYO 每用户自带 bot）。

群聊需要在「接入咕咕」页开启 group_chat_enabled 开关。QQ 平台权限决定网关能否收到
全量群消息；本平台收到的消息都会进入 IM Loop，再按回应方式决定回复或静默记录：
group_requires_at 表示只回复 @ 消息，group_read_enabled 表示全部静默记录。

和飞书长连接同模式：raw WebSocket outbound 主动连，**不需要公网**（备案前也能用）。
BYO 模型：每个用户在「个人设置 → 接入咕咕 → QQ」填自己的 AppID/Secret（存 user_bots 表），
supervisor 为每个启用的 user_bot 起一条本网关子进程。bot 收到的消息天然归属该 bot 的 owner，
所以入队 payload 直接带 owner_user_id，worker 无需再做绑定。

凭据来源分两端：
  - 接收（本网关子进程）：由 supervisor 通过环境变量注入（不走 argv，避免 ps 泄漏 secret）
  - 发送（worker 进程）：按 bot id 现查 user_bots 表

启动（由 supervisor 拉起，注入 QQ_* 环境变量）：
    QQ_BOT_ID=.. QQ_APP_ID=.. QQ_APP_SECRET=.. QQ_SANDBOX=0 QQ_OWNER=.. \
      .venv/bin/python -m agent.gateway.qq
"""
from __future__ import annotations

from contextlib import suppress
from typing import Any, Dict

import aiohttp
import asyncio
import json
import logging
import os
import re
import time
from uuid import UUID

from app.core import redis as R
from app.core.redaction import redact, diag_log, diag_log_raw

_log = logging.getLogger("agent.gateway.qq")

STREAM = R.IM_INBOUND_STREAM
_ACK_COOLDOWN = 10.0   # 同一用户「文件收到啦」秒回的冷却秒数：连发多图/文件只 ack 一次，不刷屏


_QQ_API_BASE = "https://api.sgroup.qq.com"
_QQ_SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com"
_QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"

_OP_DISPATCH = 0
_OP_HEARTBEAT = 1
_OP_IDENTIFY = 2
_OP_RESUME = 6
_OP_RECONNECT = 7
_OP_INVALID_SESSION = 9
_OP_HELLO = 10
_OP_HEARTBEAT_ACK = 11

_INTENT_GROUP_AND_C2C = 1 << 25
_INTENTS = _INTENT_GROUP_AND_C2C
_RECONNECT_DELAYS = [1, 2, 5, 10, 30, 60]
_HEARTBEAT_ACK_TIMEOUT_MULTIPLIER = 2.5
from agent.im.parsers.qq import (
    _contains_qq_face,
    _extract_quoted,
    _extract_qq_faces,
    _normalize_qq_faces,
    _pop_pending_qq_face,
    _queue_pending_qq_face,
    _qq_face_pending_key,
    _strip_qq_face_markers,
)


def _heartbeat_ack_expired(last_ack_at: float, interval: float, now: float) -> bool:
    """连续超过两个心跳周期未获确认时，认为网关连接已失效。"""
    return now - last_ack_at >= interval * _HEARTBEAT_ACK_TIMEOUT_MULTIPLIER

def _qq_api_base(sandbox: bool) -> str:
    return _QQ_SANDBOX_API_BASE if sandbox else _QQ_API_BASE


async def _qq_access_token(app_id: str, secret: str) -> str:
    async with aiohttp.ClientSession() as sess:
        async with sess.post(
            _QQ_TOKEN_URL,
            json={"appId": app_id, "clientSecret": secret},
            headers={"Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            data = await resp.json()
    token = data.get("access_token", "")
    if not token:
        # 上游响应体可能回显请求里的 appId/secret 片段，绝不能拼进异常消息（P2-b §5）；
        # 原始体只进受限诊断出口，异常消息只给通用文案。
        diag_log_raw("agent.gateway.qq._qq_access_token", f"data={data}")
        raise RuntimeError("QQ access_token 获取失败（响应缺 access_token 字段）")
    return token


async def _qq_access_token_with_ttl(app_id: str, secret: str) -> tuple[str, int]:
    async with aiohttp.ClientSession() as sess:
        async with sess.post(
            _QQ_TOKEN_URL,
            json={"appId": app_id, "clientSecret": secret},
            headers={"Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            data = await resp.json()
    token = data.get("access_token", "")
    if not token:
        diag_log_raw("agent.gateway.qq._qq_access_token_with_ttl", f"data={data}")
        raise RuntimeError("QQ access_token 获取失败（响应缺 access_token 字段）")
    return token, int(data.get("expires_in") or 0)


async def _qq_gateway_url(token: str, sandbox: bool) -> str:
    async with aiohttp.ClientSession() as sess:
        async with sess.get(
            f"{_qq_api_base(sandbox)}/gateway",
            headers={"Authorization": f"QQBot {token}"},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            data = await resp.json()
    url = data.get("url", "")
    if not url:
        diag_log_raw("agent.gateway.qq._qq_gateway_url", f"data={data}")
        raise RuntimeError("QQ gateway 获取失败（响应缺 url 字段）")
    return url


def _qq_message_mentions_bot(data: Dict[str, Any], event_type: str) -> bool:
    """依据消息体判断是否真的 @ 了机器人。

    QQ 切到 always 接收模式后，普通消息也可能使用
    ``GROUP_AT_MESSAGE_CREATE`` 事件名，不能再只看事件类型。旧测试或旧适配器
    没有 ``mentions`` 字段时保留事件类型回退。
    """
    # QQ 的 AT 事件类型是协议层对“@机器人”的明确标记，优先于可选的
    # mentions 数组；部分实际 payload 不带 mentions 或不带 bot 字段。
    if event_type == "GROUP_AT_MESSAGE_CREATE":
        return True
    if "mentions" not in data:
        return False
    mentions = data.get("mentions")
    if not isinstance(mentions, list):
        return False
    return any(isinstance(item, dict) and item.get("bot") is True for item in mentions)


def _qq_bot_mention_id(data: Dict[str, Any], event_type: str) -> str:
    """提取被 @ 的机器人平台 ID，不把未知 mention 猜成机器人。"""
    mentions = data.get("mentions")
    if isinstance(mentions, list):
        for item in mentions:
            if not isinstance(item, dict) or item.get("bot") is not True:
                continue
            for key in ("id", "user_openid", "member_openid", "openid"):
                value = item.get(key)
                if value:
                    return str(value)
    if event_type == "GROUP_AT_MESSAGE_CREATE":
        match = re.search(r"<@!?([^>]+)>", str(data.get("content") or ""))
        if match:
            return match.group(1)
    return ""


async def _qq_ack(channel_id: str, chat_type: str, target_id: str, text: str, msg_id: str) -> None:
    try:
        if chat_type == "group":
            await _post_group(channel_id, target_id, text, msg_id)
        else:
            await _post(channel_id, target_id, text, msg_id)
    except Exception as e:
        # best-effort：这只是"收到啦"的秒回提示，失败不影响正式回复走 worker 那条主链路，
        # 可以广吞，但仍要留痕方便排查。
        diag_log("agent.gateway.qq._qq_ack", e)
        _log.warning("[qq] 即时回复失败: %s", redact(f"{type(e).__name__}: {e}"))


async def _handle_raw_qq_message(event_type: str, data: Dict[str, Any],
                                 channel_id: str, owner: str, last_ack: dict) -> None:
    read_enabled = False
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
        # 兼容旧的测试/自定义适配器返回二元组；正式实现始终返回三元组。
        read_enabled = bool(group_settings[2]) if len(group_settings) > 2 else False
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
    # 成员 mention 保留原始 ID；展示层按会话内最新 username 解析，避免改名后被旧昵称冻结。
    raw_text = (data.get("content") or "").strip()
    from agent import logsafe
    has_qq_face = _contains_qq_face(raw_text)
    face_ids = _extract_qq_faces(raw_text)
    # QQ 经常把一个表情拆成「协议文本」和紧随其后的图片事件；协议文本本身不应成为
    # 一条独立聊天消息，也不应和图片同时显示成两个内容块。
    face_only = has_qq_face and not _strip_qq_face_markers(raw_text)
    text = _normalize_qq_faces(raw_text)
    msg_id = data.get("id") or ""
    if chat_type == "c2c":
        binding_match = re.fullmatch(r"(?:绑定|bind)\s*([0-9]{6})", text, flags=re.IGNORECASE)
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
            await _qq_ack(channel_id, chat_type, sender_id, reply, msg_id)
            return
    raw_attachments = data.get("attachments") or []
    if not isinstance(raw_attachments, list):
        raw_attachments = []
    # 引用原文单独存 quoted_text，不拼进 text——runner.py 只把它喂给模型当上下文，
    # ConversationMessage.content/网页展示仍是用户自己打的话，别再把引用原文拼进正文
    # （网页气泡纯文本渲染，拼进去会把引用的 markdown 原样摊平显示得很难看，见 devlog 2026-07-10）。
    quoted_text, quoted_attachments = _extract_quoted(data)
    quoted_text = _normalize_qq_faces(quoted_text)
    if quoted_attachments and quoted_text == "[QQ表情]":
        quoted_text = ""
    if quoted_attachments:
        quoted_attachments = [dict(item, quoted=True) for item in quoted_attachments]
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
        # 附件确认也属于对外回复：只响应 @ 时，非 @ 消息不能发送确认；
        # 静默记录模式即使被 @ 也不发送确认。
        should_reply = (
            chat_type != "group"
            or (
                not read_enabled
                and (not requires_at or mentioned)
            )
        )
        if should_reply and now - last_ack.get(ack_key, 0.0) > _ACK_COOLDOWN:
            last_ack[ack_key] = now
            await _qq_ack(channel_id, chat_type, ack_target, "文件收到啦，让我看看~", msg_id)
    if not text and not all_attachments and not quoted_text:
        return
    from agent import trace
    tid = trace.new_trace()
    payload = {
        "platform": "qq",
        "channel_id": channel_id,
        "owner_user_id": owner,
        "platform_user_id": sender_id,
        "platform_user_name": sender_name or None,
        "platform_bot_user_id": bot_platform_user_id or None,
        "message_id": msg_id,
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
        payload["group_mentioned"] = mentioned
    from agent import logsafe
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
        from agent.im.loop import apply_im_shortcut_cancel, decide_im_shortcut
        dec = await decide_im_shortcut(
            "qq", sender_id, text,
            bot_id=channel_id,
            scope_id=chat_id or sender_id,
        )
        if dec["action"] == "cancel":
            await apply_im_shortcut_cancel(
                "qq", sender_id, dec,
                bot_id=channel_id,
                scope_id=chat_id or sender_id,
            )
            target = chat_id if chat_type == "group" else sender_id
            await _qq_ack(channel_id, chat_type, target, dec["reply"], msg_id)
            return
        if dec["action"] == "no_permission":
            # 咕咕在跑别人的 loop，当前用户无权取消：回一句提示，不写取消标志、不入队。
            target = chat_id if chat_type == "group" else sender_id
            await _qq_ack(channel_id, chat_type, target, dec["reply"], msg_id)
            return

    try:
        await R.produce(STREAM, payload)
    except Exception as e:
        # 入队失败＝这条用户消息会被丢——不是无关紧要的 best-effort，值得响亮记录（受限出口留原始，
        # 可见日志留脱敏摘要），但不重试：Redis 层面的问题重试一次大概率还是失败，且这里已经是
        # 网关事件回调里，没有把整条 WS 消息回放重放的机制，重试意义不大，交给运维看诊断日志处理。
        diag_log("agent.gateway.qq._handle_raw_qq_message.enqueue", e)
        _log.error("[qq] 入队失败: %s", redact(f"{type(e).__name__}: {e}"))


async def _run_raw_ws(app_id: str, secret: str, sandbox: bool, channel_id: str, owner: str) -> None:
    from agent import logsafe

    channel_fp = logsafe.fingerprint(channel_id)
    session_id = None
    last_seq = None
    reconnect_attempt = 0
    last_ack: dict = {}
    while True:
        try:
            token = await _qq_access_token(app_id, secret)
            gateway = await _qq_gateway_url(token, sandbox)
            async with aiohttp.ClientSession() as sess:
                async with sess.ws_connect(gateway, heartbeat=None, receive_timeout=None) as ws:
                    print(f"[qq:{logsafe.fingerprint(channel_id)}] raw WebSocket 已连接（owner={logsafe.fingerprint(owner)}, sandbox={sandbox}）", flush=True)
                    reconnect_attempt = 0
                    heartbeat_task = None
                    last_heartbeat_ack_at = time.monotonic()
                    try:
                        async for msg in ws:
                            if msg.type != aiohttp.WSMsgType.TEXT:
                                continue
                            packet = json.loads(msg.data)
                            op = packet.get("op")
                            seq = packet.get("s")
                            event_type = packet.get("t")
                            data = packet.get("d") or {}
                            if seq is not None:
                                last_seq = seq
                            if op == _OP_HELLO:
                                interval = ((data or {}).get("heartbeat_interval") or 45000) / 1000
                                last_heartbeat_ack_at = time.monotonic()

                                async def _heartbeat():
                                    while not ws.closed:
                                        await asyncio.sleep(interval)
                                        now = time.monotonic()
                                        if _heartbeat_ack_expired(last_heartbeat_ack_at, interval, now):
                                            _log.warning(
                                                "[qq:%s] 心跳确认超时，关闭连接后按退避策略重连",
                                                channel_id,
                                            )
                                            await ws.close()
                                            return
                                        try:
                                            await ws.send_json({"op": _OP_HEARTBEAT, "d": last_seq})
                                        except asyncio.CancelledError:
                                            raise
                                        except Exception as e:
                                            diag_log("agent.gateway.qq.heartbeat", e)
                                            _log.warning(
                                                "[qq:%s] 心跳发送失败，关闭连接后按退避策略重连: %s",
                                                channel_id,
                                                redact(f"{type(e).__name__}: {e}"),
                                            )
                                            await ws.close()
                                            return

                                heartbeat_task = asyncio.create_task(_heartbeat())
                                if session_id and last_seq is not None:
                                    await ws.send_json({"op": _OP_RESUME, "d": {
                                        "token": f"QQBot {token}",
                                        "session_id": session_id,
                                        "seq": last_seq,
                                    }})
                                else:
                                    await ws.send_json({"op": _OP_IDENTIFY, "d": {
                                        "token": f"QQBot {token}",
                                        "intents": _INTENTS,
                                        "shard": [0, 1],
                                    }})
                            elif op == _OP_HEARTBEAT_ACK:
                                last_heartbeat_ack_at = time.monotonic()
                            elif op == _OP_DISPATCH:
                                if event_type == "READY":
                                    session_id = data.get("session_id")
                                    print(f"[qq:{channel_fp}] raw WebSocket READY", flush=True)
                                elif event_type == "RESUMED":
                                    print(f"[qq:{channel_fp}] raw WebSocket RESUMED", flush=True)
                                elif event_type in ("C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"):
                                    await _handle_raw_qq_message(event_type, data, channel_id, owner, last_ack)
                            elif op == _OP_RECONNECT:
                                print(f"[qq:{channel_fp}] QQ 要求重连", flush=True)
                                break
                            elif op == _OP_INVALID_SESSION:
                                print(f"[qq:{channel_fp}] QQ session 失效", flush=True)
                                session_id = None
                                last_seq = None
                                break
                    finally:
                        if heartbeat_task:
                            heartbeat_task.cancel()
                            with suppress(asyncio.CancelledError):
                                await heartbeat_task
        except Exception as e:
            # 网关连接的最外层兜底：token/gateway 获取、WS 握手、消息处理里任何没被内层捕获的异常
            # 都汇聚到这——包括编程错误（不新增分类，交给下面统一记录）。协议本身要求"断了就重连"，
            # 所以这里不改变"无条件重连"的行为，只把原始异常和可见日志的出口按 P2-b §3 分开：
            # 原始 traceback 只进受限诊断出口，gugu.log/Debug 面板只看到脱敏摘要 + 异常类型名。
            diag_log(f"agent.gateway.qq._run_raw_ws.{channel_id}", e)
            _log.error("[qq:%s] raw WebSocket 异常: %s", channel_fp, redact(f"{type(e).__name__}: {e}"))
        delay = _RECONNECT_DELAYS[min(reconnect_attempt, len(_RECONNECT_DELAYS) - 1)]
        reconnect_attempt += 1
        await asyncio.sleep(delay)


def serve() -> None:
    app_id = os.environ.get("QQ_APP_ID", "")
    secret = os.environ.get("QQ_APP_SECRET", "")
    sandbox = os.environ.get("QQ_SANDBOX", "0") in ("1", "true", "True")
    channel_id = os.environ.get("QQ_BOT_ID", "")
    owner = os.environ.get("QQ_OWNER", "")
    if not app_id or not secret:
        raise SystemExit("缺少 QQ_APP_ID / QQ_APP_SECRET 环境变量（应由 supervisor 注入）。")
    from agent import logsafe
    print(f"[qq:{logsafe.fingerprint(channel_id)}] 网关启动（raw WebSocket, sandbox={sandbox}）…", flush=True)
    asyncio.run(_run_raw_ws(app_id, secret, sandbox, channel_id, owner))


# ── 发送（worker 用，按 bot id 现查 DB 取凭据，raw HTTP 直连 QQ Bot API，不再依赖 botpy）──
_QQ_TOKEN_SAFETY_MARGIN = 60   # 提前 60s 判过期，避免请求发出瞬间 token 恰好过期
_send_tokens: dict = {}   # channel_id -> {"token", "base", "expires_at"}

# msg_seq：QQ 按 (msg_id, msg_seq) 去重，同一条用户消息的多次回复/重试必须用不同 seq。
# 网关 ack 和 worker 回复是**两个进程**，都回同一条 msg_id，得跨进程发号——用 Redis INCR
# 按 msg_id 单调递增（网关 ack 拿 1、worker 文本拿 2、文件拿 3…），保证唯一且递增。
async def _next_seq(msg_id: str | None) -> int:
    if not msg_id:
        return 1
    try:
        k = f"qqseq:{msg_id}"
        n = await R.get_redis().incr(k)
        if n == 1:
            await R.get_redis().expire(k, 600)   # 比 5min 被动窗口稍长
        return n
    except Exception:
        import time as _t
        return int(_t.time() * 1000) % 1_000_000   # Redis 挂了退回时间戳尾数


async def _creds_by_id(bot_id: str) -> tuple[str, str, bool]:
    """worker 端：按 user_bots.id 取 (app_id, app_secret, sandbox)。"""
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import UserBot
    async with _sess._SessionLocal() as db:
        b = await db.get(UserBot, int(bot_id))
        if not b:
            return "", "", False
        return b.app_id, b.app_secret, b.sandbox


from agent.im.permissions import resolve_group_policy as _group_settings


async def _send_token(channel_id: str) -> tuple[str, str]:
    """返回 (access_token, api_base)，按 channel_id 缓存，过期前自动刷新。"""
    cached = _send_tokens.get(channel_id)
    now = time.time()
    if cached and now < cached["expires_at"] - _QQ_TOKEN_SAFETY_MARGIN:
        return cached["token"], cached["base"]
    app_id, secret, sandbox = await _creds_by_id(channel_id)
    if not app_id:
        raise RuntimeError(f"user_bot {channel_id} 不存在或无凭据")
    token, expires_in = await _qq_access_token_with_ttl(app_id, secret)
    base = _qq_api_base(sandbox)
    _send_tokens[channel_id] = {"token": token, "base": base, "expires_at": now + expires_in}
    return token, base


class QQAPIError(Exception):
    """QQ Bot API 返回非 2xx。status 是 HTTP 状态码，供上层判定瞬时/永久（P2-b §1/§6）；
    body 是原始响应体，只用于内部判定（如 markdown 权限被拒的错误码）和受限诊断出口，
    **绝不**直接拼进 str(exc)——上游响应体可能回显请求内容，不能原样进可见日志/外发文案（§5）。"""

    def __init__(self, method: str, path: str, status: int, body: Any):
        self.method = method
        self.path = path
        self.status = status
        self.body = body
        super().__init__(f"QQ API {method} {path} 失败 status={status}")


def _qq_is_transient(exc: BaseException) -> bool:
    """判定失败是否值得重试：真正瞬时的（超时/连接错/5xx/429）才重试；401 也算——
    换新 token 重发是既有的、安全的做法（旧 token 从未被 QQ 处理成功，重发不会重复），
    `_qq_request` 内部已对 401 做一次透明重试，这里放行是给外层（token 缓存已失效、
    换个全新请求）再兜一次。其余 4xx（参数错/内容被拒等）是永久错误，重试不会变成功，
    只会白白重复发送（§1/§6）。"""
    if isinstance(exc, (asyncio.TimeoutError, aiohttp.ClientConnectionError, aiohttp.ServerTimeoutError)):
        return True
    if isinstance(exc, QQAPIError):
        return exc.status >= 500 or exc.status in (401, 429)
    # 兼容非 QQAPIError 的 401 语义（如更底层就失败、还没走到 _qq_request 状态码分支）
    s = str(exc)
    return "status=401" in s or "code: 401" in s


async def _qq_request(channel_id: str, method: str, path: str, *,
                      json_body: dict | None = None, retry_on_401: bool = True):
    """raw HTTP 调 QQ Bot API；401 时清缓存重取 token 重试一次（幂等：读token+重发同一请求，
    未产生额外副作用，安全）。其余非 2xx 抛 QQAPIError，由调用方按 _qq_is_transient 判定是否重试。"""
    token, base = await _send_token(channel_id)
    async with aiohttp.ClientSession() as sess:
        async with sess.request(
            method, f"{base}{path}", json=json_body,
            headers={"Authorization": f"QQBot {token}", "Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=20),
        ) as resp:
            status = resp.status
            try:
                data = await resp.json(content_type=None)
            except Exception:
                # 响应体不是合法 JSON（QQ 偶尔回纯文本错误页）：退化取文本，不影响 status 判定，
                # 广吞合理——这里只是"尽量拿到点诊断信息"，拿不到也不影响后面的状态码分支。
                data = await resp.text()
    if status in (200, 201, 204):
        return data
    if status == 401 and retry_on_401:
        _send_tokens.pop(channel_id, None)
        return await _qq_request(channel_id, method, path, json_body=json_body, retry_on_401=False)
    diag_log_raw("agent.gateway.qq._qq_request",
                  f"{method} {path} status={status} body={data}")
    raise QQAPIError(method, path, status, data)


def _markdown_blocked(exc: Exception) -> bool:
    """该 bot 没开通原生 markdown 权限的报错（回退纯文本）。优先从结构化 body 判定；
    非 QQAPIError（如连接层异常）没有 body，退回旧的字符串启发式兼容。"""
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        code = body.get("code")
        msg = str(body.get("message") or "")
        if code in (50056, 40034012) or "不允许发送原生 markdown" in msg:
            return True
        return False
    s = str(body) if body is not None else str(exc)
    return ("50056" in s or "40034012" in s or "不允许发送原生 markdown" in s)


def _qq_msg_id_invalid(exc: Exception) -> bool:
    """QQ 被动回复窗口过期或 msg_id 越权时，允许降级为主动消息。"""
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        if body.get("code") == 40034024 or body.get("err_code") == 40034024:
            return True
        message = str(body.get("message") or "")
        return "msg_id无效或越权" in message
    text = str(body) if body is not None else str(exc)
    return "40034024" in text or "msg_id无效或越权" in text


async def _post(channel_id: str, openid: str, text: str, msg_id: str | None):
    """先发原生 markdown(msg_type=2) 让 QQ 渲染；该 bot 无 md 权限则回退纯文本(msg_type=0)。
    每次发都取新 msg_seq，避免重复 seq 被去重。"""
    path = f"/v2/users/{openid}/messages"
    body = {
        "msg_type": 2, "markdown": {"content": text},
        "msg_seq": await _next_seq(msg_id),
    }
    if msg_id:
        body["msg_id"] = msg_id
    try:
        await _qq_request(channel_id, "POST", path, json_body=body)
    except Exception as me:
        if not _markdown_blocked(me):
            raise
        body = {"msg_type": 0, "content": text, "msg_seq": await _next_seq(msg_id)}
        if msg_id:
            body["msg_id"] = msg_id
        await _qq_request(channel_id, "POST", path, json_body=body)


async def _post_group(channel_id: str, group_openid: str, text: str, msg_id: str | None):
    """群聊版 _post：先发原生 markdown，该 bot 无 md 权限则回退纯文本。"""
    path = f"/v2/groups/{group_openid}/messages"
    body = {
        "msg_type": 2, "markdown": {"content": text},
        "msg_seq": await _next_seq(msg_id),
    }
    if msg_id:
        body["msg_id"] = msg_id
    try:
        await _qq_request(channel_id, "POST", path, json_body=body)
    except Exception as me:
        if not _markdown_blocked(me):
            raise
        body = {"msg_type": 0, "content": text, "msg_seq": await _next_seq(msg_id)}
        if msg_id:
            body["msg_id"] = msg_id
        await _qq_request(channel_id, "POST", path, json_body=body)


async def send_c2c(openid: str, text: str, msg_id: str | None = None,
                   channel_id: str | None = None) -> bool:
    """给指定用户发 C2C 被动回复（带原 msg_id）。只在失败判定为瞬时（超时/连接错/5xx/429）
    时重试一次；4xx 等永久错误直接失败——发消息不是幂等操作，重试会造成重复推送，
    对不会成功的永久错误重试只有坏处没有好处（P2-b §1/§4-A 幂等前提）。"""
    print(json.dumps({
        "event": "send-c2c-start",
        "has_openid": bool(openid),
        "has_channel_id": bool(channel_id),
        "has_msg_id": bool(msg_id),
    }, ensure_ascii=False), flush=True)
    for attempt in (1, 2):
        try:
            await _post(channel_id, openid, text, msg_id)
            print(json.dumps({
                "event": "send-c2c-ok",
                "attempt": attempt,
            }, ensure_ascii=False), flush=True)
            return True
        except Exception as e:
            print(json.dumps({
                "event": "send-c2c-error",
                "attempt": attempt,
                "error": type(e).__name__,
                "transient": _qq_is_transient(e),
            }, ensure_ascii=False), flush=True)
            if msg_id and _qq_msg_id_invalid(e):
                _log.warning("[qq] C2C 被动回复 msg_id 已失效，降级为主动消息")
                try:
                    await _post(channel_id, openid, text, None)
                    return True
                except Exception as fallback_error:
                    diag_log("agent.gateway.qq.send_c2c.active_fallback", fallback_error)
                    _log.warning("[qq] C2C 主动消息发送失败: %s",
                                 redact(f"{type(fallback_error).__name__}: {fallback_error}"))
                    return False
            diag_log("agent.gateway.qq.send_c2c", e)
            _log.warning("[qq] 发送失败(第%d次): %s", attempt, redact(f"{type(e).__name__}: {e}"))
            _send_tokens.pop(channel_id, None)   # 丢弃缓存，下次重新取 token
            if attempt == 2 or not _qq_is_transient(e):
                return False
            await asyncio.sleep(0.5)
    return False


async def send_group(group_openid: str, text: str, msg_id: str | None = None,
                     channel_id: str | None = None) -> bool:
    """给指定群发被动回复（带原 msg_id）。只在失败判定为瞬时时重试一次；
    4xx 等永久错误直接失败（同 send_c2c，发消息非幂等，不对永久错误盲重试）。"""
    print(json.dumps({
        "event": "send-group-start",
        "has_group_openid": bool(group_openid),
        "has_channel_id": bool(channel_id),
        "has_msg_id": bool(msg_id),
    }, ensure_ascii=False), flush=True)
    for attempt in (1, 2):
        try:
            await _post_group(channel_id, group_openid, text, msg_id)
            print(json.dumps({
                "event": "send-group-ok",
                "attempt": attempt,
            }, ensure_ascii=False), flush=True)
            return True
        except Exception as e:
            print(json.dumps({
                "event": "send-group-error",
                "attempt": attempt,
                "error": type(e).__name__,
                "transient": _qq_is_transient(e),
            }, ensure_ascii=False), flush=True)
            if msg_id and _qq_msg_id_invalid(e):
                _log.warning("[qq] 群聊被动回复 msg_id 已失效，降级为主动消息")
                try:
                    await _post_group(channel_id, group_openid, text, None)
                    return True
                except Exception as fallback_error:
                    diag_log("agent.gateway.qq.send_group.active_fallback", fallback_error)
                    _log.warning("[qq] 群聊主动消息发送失败: %s",
                                 redact(f"{type(fallback_error).__name__}: {fallback_error}"))
                    return False
            diag_log("agent.gateway.qq.send_group", e)
            _log.warning("[qq] 群发送失败(第%d次): %s", attempt, redact(f"{type(e).__name__}: {e}"))
            _send_tokens.pop(channel_id, None)
            if attempt == 2 or not _qq_is_transient(e):
                return False
            await asyncio.sleep(0.5)
    return False


# ── 发文件（worker 用）。C2C 和群聊分别走各自的富媒体上传接口 ──
_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}


async def send_file(openid: str, data: bytes | None, name: str, ext: str,
                    channel_id: str | None = None, msg_id: str | None = None,
                    group: bool = False) -> bool:
    """给 QQ 私聊或群聊发媒体；本地文件统一使用 base64 上传。"""
    import base64
    ext_l = (ext or "").lower()
    is_img = ext_l in _IMAGE_EXTS
    file_type = 1 if is_img else 4
    fname = f"{name}.{ext_l}" if ext_l else name
    if data is None:
        return False
    b64 = base64.b64encode(data).decode()
    target = "groups" if group else "users"
    # 上传 inner proxy 偶发抖动，多重试几次（每次取新 msg_seq，避免去重）
    for attempt in range(1, 5):
        try:
            # 1) 上传到 QQ 富媒体，拿 file_info。
            body = {"file_type": file_type, "srv_send_msg": False}
            body["file_data"] = b64
            if not is_img:
                body["file_name"] = fname
            media = await _qq_request(channel_id, "POST", f"/v2/{target}/{openid}/files", json_body=body)
            file_info = media.get("file_info") if isinstance(media, dict) else None
            if not file_info:
                # 只打字段名，不打整个响应体（万一 QQ 把请求里的 file_name 之类字段原样回显）
                keys = sorted(media.keys()) if isinstance(media, dict) else type(media).__name__
                print(f"[qq] 富媒体上传无 file_info: keys={keys}", flush=True)
                return False
            # 2) 发媒体消息（被动回复带 msg_id；文件用 content 让 QQ 显示文件名）
            msg_body = {"msg_type": 7, "media": {"file_info": file_info},
                       "msg_id": msg_id, "msg_seq": await _next_seq(msg_id)}
            if not is_img:
                msg_body["content"] = fname
            await _qq_request(channel_id, "POST", f"/v2/{target}/{openid}/messages", json_body=msg_body)
            return True
        except Exception as e:
            diag_log("agent.gateway.qq.send_file", e)
            _log.warning("[qq] 发文件失败(第%d次): %s", attempt, redact(f"{type(e).__name__}: {e}"))
            # token 失效才重建缓存；inner proxy 等抖动直接重试
            if isinstance(e, QQAPIError) and e.status == 401:
                _send_tokens.pop(channel_id, None)
            elif "token" in str(e).lower():
                _send_tokens.pop(channel_id, None)
            # 上传/发送都不是幂等操作（重复上传浪费、重复发送会造成重复文件消息）；
            # 只对判定为瞬时的失败继续重试，4xx 等永久错误立即放弃（P2-b §1/§4-A）。
            if attempt < 4 and _qq_is_transient(e):
                await asyncio.sleep(0.6 * attempt)
            else:
                return False
    return False


if __name__ == "__main__":
    serve()
