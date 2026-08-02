"""QQ 官方机器人网关（单聊 C2C + 群聊，BYO 每用户自带 bot）。

群聊需要在「接入咕咕」页开启 group_chat_enabled 开关；默认只响应 @ 机器人的消息，关闭
group_requires_at 后同时接收 QQ 官方的 GROUP_MESSAGE_CREATE 全量群消息事件。开启
group_read_enabled 后会额外接收并保存未 @ 咕咕的普通群消息；只有 @ 咕咕的消息才触发回复。

和飞书长连接同模式：raw WebSocket outbound 主动连，**不需要公网**（备案前也能用）。
BYO 模型：每个用户在「个人设置 → 接入咕咕 → QQ」填自己的 AppID/Secret（存 user_bots 表），
supervisor 为每个启用的 user_bot 起一条本网关子进程。bot 收到的消息天然归属该 bot 的 owner，
所以入队 payload 直接带 owner_user_id，worker 无需再做绑定。

凭据来源分两端：
  - 接收（本网关子进程）：由 supervisor 通过环境变量注入（不走 argv，避免 ps 泄漏 secret）
  - 发送（worker 进程）：按 bot id 现查 user_bots 表

启动（由 supervisor 拉起，注入 QQ_* 环境变量）：
    QQ_BOT_ID=.. QQ_APP_ID=.. QQ_APP_SECRET=.. QQ_SANDBOX=0 QQ_OWNER=.. \
      .venv/bin/python -m agent.adapters.qq
"""
from __future__ import annotations

from contextlib import suppress
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import aiohttp
import asyncio
import json
import logging
import os
import time

from app.core import redis as R
from app.core.redaction import redact, diag_log, diag_log_raw

_log = logging.getLogger("agent.adapters.qq")

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
_RECONNECT_DELAYS = [1, 2, 5, 10, 30, 60]
_HEARTBEAT_ACK_TIMEOUT_MULTIPLIER = 2.5


def _heartbeat_ack_expired(last_ack_at: float, interval: float, now: float) -> bool:
    """连续超过两个心跳周期未获确认时，认为网关连接已失效。"""
    return now - last_ack_at >= interval * _HEARTBEAT_ACK_TIMEOUT_MULTIPLIER

def _find_quoted_element(raw_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """从原始 payload 中找到被引用的消息元素。

    QQ 的 msg_elements 列表包含当前会话的上下文消息，其中用户引用的消息
    通过 message_scene.ext 里的 ref_msg_idx 定位。
    """
    msg_elements: List[Dict[str, Any]] = raw_data.get("msg_elements") or []
    if not msg_elements:
        return None

    scene_ext = _message_scene_ext(raw_data)
    ref_idx = _scene_ext_value(scene_ext, "ref_msg_idx")
    if not ref_idx:
        ref_idx = _scene_ext_value(scene_ext, "msg_ref_idx")

    if not ref_idx:
        return None

    for elem in msg_elements:
        if isinstance(elem, dict):
            if str(elem.get("msg_idx", "")) == ref_idx:
                return elem

    # fallback：ref_msg_idx 存在但没精确命中时，取不是当前消息的上下文元素。
    own_idx = _scene_ext_value(scene_ext, "msg_idx")
    for elem in msg_elements:
        if isinstance(elem, dict) and str(elem.get("msg_idx", "")) != own_idx:
            return elem
    return None


def _message_scene_ext(raw_data: Dict[str, Any]) -> list:
    scene = raw_data.get("message_scene") or {}
    if not isinstance(scene, dict):
        return []
    ext = scene.get("ext") or []
    return ext if isinstance(ext, list) else []


def _scene_ext_value(scene_ext: list, key: str) -> str:
    prefix = f"{key}="
    for entry in scene_ext:
        if isinstance(entry, str) and entry.startswith(prefix):
            return entry[len(prefix):].strip()
        if isinstance(entry, dict):
            if entry.get("key") == key:
                return str(entry.get("value") or "").strip()
            if key in entry:
                return str(entry.get(key) or "").strip()
    return ""


def _extract_quoted(raw_data: Dict[str, Any]) -> tuple[str, list]:
    """返回 (引用文本, 引用附件列表)。没有引用时返回 ("", [])。"""
    elem = _find_quoted_element(raw_data)
    if not elem:
        return "", []
    text = (elem.get("content") or elem.get("text") or "").strip()
    text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    attachments = elem.get("attachments") or []
    if not isinstance(attachments, list):
        attachments = []
    return text, _dedupe_attachments(attachments + _collect_media_attachments(elem))


def _collect_media_attachments(value) -> list:
    """从 QQ 引用元素的嵌套结构里递归找媒体 URL，兼容非 attachments 字段。"""
    found: list = []

    def _walk(v):
        if isinstance(v, dict):
            url = (
                v.get("url")
                or v.get("file_url")
                or v.get("download_url")
                or v.get("image_url")
                or v.get("origin_url")
                or v.get("preview_url")
            )
            if isinstance(url, str) and url:
                found.append({
                    "url": url,
                    "filename": (
                        v.get("filename")
                        or v.get("file_name")
                        or v.get("name")
                        or "引用图片.jpg"
                    ),
                    "content_type": v.get("content_type") or v.get("type"),
                })
            for child in v.values():
                _walk(child)
        elif isinstance(v, list):
            for child in v:
                _walk(child)

    _walk(value)
    # 去重，避免同一个 URL 在多个预览字段里重复暂存。
    deduped: list = []
    seen: set[str] = set()
    for item in found:
        url = item.get("url")
        if url and url not in seen:
            seen.add(url)
            deduped.append(item)
    return deduped


def _dedupe_attachments(attachments: list) -> list:
    deduped: list = []
    seen: set[str] = set()
    for item in attachments:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if url and url in seen:
            continue
        if url:
            seen.add(url)
        deduped.append(item)
    return deduped


def _log_quote_shape_if_needed(channel_id: str, raw_data: Dict[str, Any], found: bool,
                               attachment_count: int = 0) -> None:
    """引用没识别到或引用媒体没拿到时打印结构，不打印正文。"""
    scene_ext = _message_scene_ext(raw_data)
    msg_elements = raw_data.get("msg_elements") or []
    if not scene_ext and not msg_elements:
        return
    quoted_elem = _find_quoted_element(raw_data)
    if found and attachment_count:
        return
    element_keys = []
    if isinstance(msg_elements, list):
        for elem in msg_elements[:3]:
            if isinstance(elem, dict):
                element_keys.append(sorted(elem.keys()))
    quoted_keys = sorted(quoted_elem.keys()) if isinstance(quoted_elem, dict) else []
    nested_keys = _nested_key_shape(quoted_elem)
    print(f"[qq:{channel_id}] 引用结构未命中: ext={scene_ext} "
          f"msg_elements={len(msg_elements) if isinstance(msg_elements, list) else 0} "
          f"found={found} att={attachment_count} element_keys={element_keys} "
          f"quoted_keys={quoted_keys} nested_keys={nested_keys}", flush=True)


def _nested_key_shape(value, limit: int = 8) -> list:
    keys: list = []

    def _walk(v):
        if len(keys) >= limit:
            return
        if isinstance(v, dict):
            keys.append(sorted(v.keys()))
            for child in v.values():
                _walk(child)
        elif isinstance(v, list):
            for child in v:
                _walk(child)

    _walk(value)
    return keys


def _raw_attachments_to_message(attachments: list):
    """把 QQ raw attachment dict 包成现有 _ingest_qq_media 需要的属性对象。"""
    return SimpleNamespace(
        attachments=[
            SimpleNamespace(
                url=a.get("url"),
                filename=a.get("filename") or a.get("file_name") or "file",
                content_type=a.get("content_type") or a.get("type"),
            )
            for a in attachments
            if isinstance(a, dict)
        ],
    )


async def _ingest_qq_media(message: Any, owner: str) -> list:
    """下载 QQ 消息里的图片/文件 → 暂存 → 返回 [attach_id]。handler 是 async，直接用 async stage。"""
    atts = getattr(message, "attachments", None) or []
    if not atts:
        return []
    import aiohttp
    from app.core import chat_attach
    out: list = []
    async with aiohttp.ClientSession() as sess:
        for a in atts:
            url = getattr(a, "url", None)
            if not url:
                continue
            if not url.startswith("http"):
                url = "https://" + url.lstrip("/")
            fname = getattr(a, "filename", None) or "file"
            name, _, ext = fname.rpartition(".")
            name = name or fname
            mime = getattr(a, "content_type", None)
            try:
                async with sess.get(url, timeout=aiohttp.ClientTimeout(total=60)) as resp:
                    if resp.status != 200:
                        print(f"[qq] 下载附件失败 status={resp.status}", flush=True)
                        continue
                    data = await resp.read()
                # 语音/音频：QQ 语音是 SILK 等 mimo 不支持的编码 → 转成 mp3 再暂存，
                # 这样 resolve_for_message 才会按音频喂给模型听（缺 ffmpeg/pilk 则原样、退文字提示）。
                # QQ 语音原编码就是 silk/amr，转码成功＝这是一条「语音消息」→ 渲染成语音条 + 30 天独立存储。
                is_voice = False
                from app.core import media_transcode
                if ext not in ("mp3", "wav", "flac", "m4a", "ogg"):
                    conv = media_transcode.to_mimo_mp3(data, ext, mime)
                    if conv is not None:
                        data, ext, mime, name = conv, "mp3", "audio/mpeg", (name or "语音")
                        is_voice = True
                if is_voice:
                    dur = media_transcode.probe_duration(data, ext)
                    meta = await chat_attach.stage_voice(owner, name, ext, mime, data, duration=dur, platform="qq")
                else:
                    meta = await chat_attach.stage(owner, name, ext, mime, data, platform="qq")
                out.append(meta["attach_id"])
            except Exception as e:
                # best-effort：单个附件下载/转码/暂存失败（网络抖动、ffmpeg 缺失、解码错…原因很杂）
                # 不该拖垮其余附件的处理，跳过继续；但仍要留痕（受限出口拿原始，可见日志只留脱敏摘要）。
                diag_log("agent.adapters.qq._ingest_qq_media", e)
                _log.warning("[qq] 暂存附件出错: %s", redact(f"{type(e).__name__}: {e}"))
    return out


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
        diag_log_raw("agent.adapters.qq._qq_access_token", f"data={data}")
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
        diag_log_raw("agent.adapters.qq._qq_access_token_with_ttl", f"data={data}")
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
        diag_log_raw("agent.adapters.qq._qq_gateway_url", f"data={data}")
        raise RuntimeError("QQ gateway 获取失败（响应缺 url 字段）")
    return url


async def _qq_ack(channel_id: str, chat_type: str, target_id: str, text: str, msg_id: str) -> None:
    try:
        if chat_type == "group":
            await _post_group(channel_id, target_id, text, msg_id)
        else:
            await _post(channel_id, target_id, text, msg_id)
    except Exception as e:
        # best-effort：这只是"收到啦"的秒回提示，失败不影响正式回复走 worker 那条主链路，
        # 可以广吞，但仍要留痕方便排查。
        diag_log("agent.adapters.qq._qq_ack", e)
        _log.warning("[qq] 即时回复失败: %s", redact(f"{type(e).__name__}: {e}"))


async def _handle_raw_qq_message(event_type: str, data: Dict[str, Any],
                                 channel_id: str, owner: str, last_ack: dict) -> None:
    read_enabled = False
    mentioned = event_type == "GROUP_AT_MESSAGE_CREATE"
    if event_type == "C2C_MESSAGE_CREATE":
        chat_type = "c2c"
        author = data.get("author") or {}
        sender_id = author.get("user_openid") or author.get("id") or ""
        chat_id = ""
    elif event_type in {"GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"}:
        group_settings = await _group_settings(channel_id)
        group_enabled, requires_at = group_settings[:2]
        # 兼容旧的测试/自定义适配器返回二元组；正式实现始终返回三元组。
        read_enabled = bool(group_settings[2]) if len(group_settings) > 2 else False
        if not group_enabled:
            return
        # 只读取模式的目的就是收集群内全部消息；它覆盖“只响应 @”筛选，
        # 但仍通过 payload 标记让 worker 全链路静默，不向群内发消息。
        if event_type == "GROUP_MESSAGE_CREATE" and requires_at and not read_enabled:
            return
        chat_type = "group"
        author = data.get("author") or {}
        sender_id = author.get("member_openid") or author.get("id") or ""
        chat_id = data.get("group_openid") or ""
    else:
        return
    if not sender_id:
        return
    text = (data.get("content") or "").strip()
    msg_id = data.get("id") or ""
    raw_attachments = data.get("attachments") or []
    if not isinstance(raw_attachments, list):
        raw_attachments = []
    # 引用原文单独存 quoted_text，不拼进 text——runner.py 只把它喂给模型当上下文，
    # ConversationMessage.content/网页展示仍是用户自己打的话，别再把引用原文拼进正文
    # （网页气泡纯文本渲染，拼进去会把引用的 markdown 原样摊平显示得很难看，见 devlog 2026-07-10）。
    quoted_text, quoted_attachments = _extract_quoted(data)
    _log_quote_shape_if_needed(
        channel_id, data, bool(quoted_text or quoted_attachments), len(quoted_attachments))
    all_attachments = raw_attachments + quoted_attachments
    if all_attachments:
        ack_target = chat_id if chat_type == "group" else sender_id
        now = time.monotonic()
        ack_key = f"{chat_type}:{ack_target}"
        if (mentioned or not (chat_type == "group" and read_enabled)) \
                and now - last_ack.get(ack_key, 0.0) > _ACK_COOLDOWN:
            last_ack[ack_key] = now
            await _qq_ack(channel_id, chat_type, ack_target, "文件收到啦，让我看看~", msg_id)
    attachments = await _ingest_qq_media(_raw_attachments_to_message(all_attachments), owner)
    if not text and not attachments and not quoted_text:
        return
    from agent import trace
    tid = trace.new_trace()
    payload = {
        "platform": "qqbot",
        "channel_id": channel_id,
        "owner_user_id": owner,
        "platform_user_id": sender_id,
        "message_id": msg_id,
        "chat_type": chat_type,
        "text": text,
        "quoted_text": quoted_text or None,
        "attachments": attachments,
        "trace_id": tid,
    }
    if chat_type == "group":
        payload["chat_id"] = chat_id
        payload["group_read_enabled"] = read_enabled
        payload["group_mentioned"] = mentioned
    from agent import logsafe
    if chat_type == "group":
        print(f"[qq:{channel_id}] 收到群 {chat_id} 内 {sender_id}: text_len={len(text)} "
              f"fp={logsafe.fingerprint(text)} att={len(attachments)} trace={tid}", flush=True)
    else:
        print(f"[qq:{channel_id}] 收到 {sender_id}: text_len={len(text)} "
              f"fp={logsafe.fingerprint(text)} att={len(attachments)} trace={tid}", flush=True)

    if not attachments:
        from agent import router, runtime_state as rtstate
        dec = router.decide(text, await rtstate.get_state("qqbot", sender_id),
                            await rtstate.is_awaiting("qqbot", sender_id))
        if dec["action"] == "drop":
            return
        if dec["action"] in ("reply", "cancel"):
            if dec["action"] == "cancel":
                await rtstate.request_cancel("qqbot", sender_id)
            target = chat_id if chat_type == "group" else sender_id
            await _qq_ack(channel_id, chat_type, target, dec["reply"], msg_id)
            return
    try:
        await R.produce(STREAM, payload)
    except Exception as e:
        # 入队失败＝这条用户消息会被丢——不是无关紧要的 best-effort，值得响亮记录（受限出口留原始，
        # 可见日志留脱敏摘要），但不重试：Redis 层面的问题重试一次大概率还是失败，且这里已经是
        # 网关事件回调里，没有把整条 WS 消息回放重放的机制，重试意义不大，交给运维看诊断日志处理。
        diag_log("agent.adapters.qq._handle_raw_qq_message.enqueue", e)
        _log.error("[qq] 入队失败: %s", redact(f"{type(e).__name__}: {e}"))


async def _run_raw_ws(app_id: str, secret: str, sandbox: bool, channel_id: str, owner: str) -> None:
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
                    print(f"[qq:{channel_id}] raw WebSocket 已连接（owner={owner}, sandbox={sandbox}）", flush=True)
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
                                            diag_log("agent.adapters.qq.heartbeat", e)
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
                                        "intents": _INTENT_GROUP_AND_C2C,
                                        "shard": [0, 1],
                                    }})
                            elif op == _OP_HEARTBEAT_ACK:
                                last_heartbeat_ack_at = time.monotonic()
                            elif op == _OP_DISPATCH:
                                if event_type == "READY":
                                    session_id = data.get("session_id")
                                    print(f"[qq:{channel_id}] raw WebSocket READY session={session_id}", flush=True)
                                elif event_type == "RESUMED":
                                    print(f"[qq:{channel_id}] raw WebSocket RESUMED", flush=True)
                                elif event_type in ("C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"):
                                    await _handle_raw_qq_message(event_type, data, channel_id, owner, last_ack)
                            elif op == _OP_RECONNECT:
                                print(f"[qq:{channel_id}] QQ 要求重连", flush=True)
                                break
                            elif op == _OP_INVALID_SESSION:
                                print(f"[qq:{channel_id}] QQ session 失效", flush=True)
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
            diag_log(f"agent.adapters.qq._run_raw_ws.{channel_id}", e)
            _log.error("[qq:%s] raw WebSocket 异常: %s", channel_id, redact(f"{type(e).__name__}: {e}"))
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
    print(f"[qq:{channel_id}] 网关启动（raw WebSocket, sandbox={sandbox}）…", flush=True)
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


async def _group_settings(bot_id: str) -> tuple[bool, bool, bool]:
    """网关接收端用：按 user_bots.id 现查群聊开关。
    每条群消息都查一次而不是启动时缓存，换来「切开关立即生效、不用重启网关子进程」。"""
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import UserBot
    async with _sess._SessionLocal() as db:
        b = await db.get(UserBot, int(bot_id))
        if not b:
            return False, True, False
        return b.group_chat_enabled, b.group_requires_at, b.group_read_enabled


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
    diag_log_raw("agent.adapters.qq._qq_request",
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


async def _post(channel_id: str, openid: str, text: str, msg_id: str | None):
    """先发原生 markdown(msg_type=2) 让 QQ 渲染；该 bot 无 md 权限则回退纯文本(msg_type=0)。
    每次发都取新 msg_seq，避免重复 seq 被去重。"""
    path = f"/v2/users/{openid}/messages"
    try:
        await _qq_request(channel_id, "POST", path, json_body={
            "msg_type": 2, "markdown": {"content": text},
            "msg_id": msg_id, "msg_seq": await _next_seq(msg_id),
        })
    except Exception as me:
        if not _markdown_blocked(me):
            raise
        await _qq_request(channel_id, "POST", path, json_body={
            "msg_type": 0, "content": text,
            "msg_id": msg_id, "msg_seq": await _next_seq(msg_id),
        })


async def _post_group(channel_id: str, group_openid: str, text: str, msg_id: str | None):
    """群聊版 _post：先发原生 markdown，该 bot 无 md 权限则回退纯文本。"""
    path = f"/v2/groups/{group_openid}/messages"
    try:
        await _qq_request(channel_id, "POST", path, json_body={
            "msg_type": 2, "markdown": {"content": text},
            "msg_id": msg_id, "msg_seq": await _next_seq(msg_id),
        })
    except Exception as me:
        if not _markdown_blocked(me):
            raise
        await _qq_request(channel_id, "POST", path, json_body={
            "msg_type": 0, "content": text,
            "msg_id": msg_id, "msg_seq": await _next_seq(msg_id),
        })


async def send_c2c(openid: str, text: str, msg_id: str | None = None,
                   channel_id: str | None = None) -> bool:
    """给指定用户发 C2C 被动回复（带原 msg_id）。只在失败判定为瞬时（超时/连接错/5xx/429）
    时重试一次；4xx 等永久错误直接失败——发消息不是幂等操作，重试会造成重复推送，
    对不会成功的永久错误重试只有坏处没有好处（P2-b §1/§4-A 幂等前提）。"""
    for attempt in (1, 2):
        try:
            await _post(channel_id, openid, text, msg_id)
            return True
        except Exception as e:
            diag_log("agent.adapters.qq.send_c2c", e)
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
    for attempt in (1, 2):
        try:
            await _post_group(channel_id, group_openid, text, msg_id)
            return True
        except Exception as e:
            diag_log("agent.adapters.qq.send_group", e)
            _log.warning("[qq] 群发送失败(第%d次): %s", attempt, redact(f"{type(e).__name__}: {e}"))
            _send_tokens.pop(channel_id, None)
            if attempt == 2 or not _qq_is_transient(e):
                return False
            await asyncio.sleep(0.5)
    return False


# ── 发文件（worker 用）。C2C 私聊支持图片(file_type=1)和文件(file_type=4)；群聊不支持发文件 ──
_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}


async def send_file(openid: str, data: bytes | None, name: str, ext: str,
                    channel_id: str | None = None, msg_id: str | None = None,
                    url: str | None = None) -> bool:
    """给 QQ 用户发图片/文件。**有 url（OSS 公网/签名地址）→ URL 模式让 QQ 自己抓（无体积限制）；
    否则 base64 上传 data（本地存储用，受 ~10MB 限制）**。C2C 图片→file_type 1、其余文件→4。"""
    import base64
    ext_l = (ext or "").lower()
    is_img = ext_l in _IMAGE_EXTS
    file_type = 1 if is_img else 4
    fname = f"{name}.{ext_l}" if ext_l else name
    b64 = base64.b64encode(data).decode() if (data is not None and not url) else None
    # 上传 inner proxy 偶发抖动，多重试几次（每次取新 msg_seq，避免去重）
    for attempt in range(1, 5):
        try:
            # 1) 上传到 QQ 富媒体，拿 file_info（url 模式让 QQ 抓；否则 base64 file_data）
            body = {"file_type": file_type, "srv_send_msg": False}
            if url:
                body["url"] = url
            else:
                body["file_data"] = b64
            if not is_img:
                body["file_name"] = fname
            media = await _qq_request(channel_id, "POST", f"/v2/users/{openid}/files", json_body=body)
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
            await _qq_request(channel_id, "POST", f"/v2/users/{openid}/messages", json_body=msg_body)
            return True
        except Exception as e:
            diag_log("agent.adapters.qq.send_file", e)
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
