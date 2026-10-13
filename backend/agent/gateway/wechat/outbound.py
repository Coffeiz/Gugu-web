"""微信 worker 出站适配：文本、typing 与媒体上传发送。"""
from __future__ import annotations

import asyncio
import uuid
import urllib.parse as _urlparse

import httpx as _httpx

from app.core.errors import RetryableError
from app.core.redaction import diag_log, diag_log_raw, redact
from . import media_crypto as _media
from .client import (
    DEFAULT_BASE_URL,
    ILinkClient,
    MESSAGE_ITEM_TYPE_FILE,
    MESSAGE_ITEM_TYPE_IMAGE,
    UPLOAD_MEDIA_TYPE_FILE,
    UPLOAD_MEDIA_TYPE_IMAGE,
)
from .typing import TypingIndicator

_clients: dict = {}


async def _creds_by_id(bot_id: str) -> tuple[str, str]:
    """worker 端：按 user_bots.id 取 (bot_token, base_url)。bot_token 存 app_secret、base_url 存 app_id。"""
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import UserBot
    async with _sess._SessionLocal() as db:
        b = await db.get(UserBot, int(bot_id))
        if not b:
            return "", DEFAULT_BASE_URL
        return b.app_secret, (b.app_id or DEFAULT_BASE_URL)


async def _client_for(channel_id: str) -> ILinkClient:
    if channel_id not in _clients:
        bot_token, base_url = await _creds_by_id(channel_id)
        if not bot_token:
            raise RuntimeError(f"user_bot {channel_id} 不存在或无 bot_token")
        c = ILinkClient(bot_token, base_url)
        await c.start()
        _clients[channel_id] = c
    return _clients[channel_id]


async def send_text(to_user_id: str, text: str, channel_id: str | None = None,
                    context_token: str = "") -> bool:
    """给微信用户发文本回复。iLink 必需 `context_token`（worker 从入站 payload 透传）。

    **非幂等，不盲重试**（P2-b §4-A 幂等前提）：`ILinkClient.send_text` 每次调用都现生成
    新 `client_id`（见 `client.py`），重试之间没有共享的幂等键——如果请求其实已经送达
    服务器（只是响应超时/断连没读到），重试会让用户收到两条一样的消息。只在**连接建立阶段
    就失败**（`ConnectError`/`ConnectTimeout`，请求肯定还没发出去，不可能已产生副作用）时
    换个 client 重试一次；其余失败（HTTP 状态错误、读超时等，请求可能已被处理）一律不重试，
    直接失败返回。"""
    import httpx
    if not context_token:
        print("[wechat] 发送缺 context_token，无法回复（iLink 端到端会话凭证）", flush=True)
        return False
    connect_transient = (httpx.ConnectError, httpx.ConnectTimeout)   # 窄白名单：只信"没发出去"这类
    for attempt in (1, 2):
        try:
            client = await _client_for(channel_id)
            resp = await client.send_text(to_user_id, text, context_token)
            ret = (resp or {}).get("ret") if isinstance(resp, dict) else None
            if ret not in (0, None):   # iLink HTTP 200 但 ret≠0 = 业务失败（如 context_token 过期），不抛异常→在此暴露
                # 只打字段名，不打整个响应体（万一原样回显了发送内容）
                keys = sorted(resp.keys()) if isinstance(resp, dict) else type(resp).__name__
                print(f"[wechat] sendmessage ret={ret}（消息可能未投递）resp_keys={keys}", flush=True)
            return True
        except connect_transient as e:
            diag_log("agent.gateway.wechat.send_text", e)
            print(f"[wechat] 发送失败(连接建立阶段, 第{attempt}次): "
                  f"{redact(f'{type(e).__name__}: {e}')}", flush=True)
            c = _clients.pop(channel_id, None)
            if c:
                try:
                    await c.stop()
                except Exception:
                    pass
        except Exception as e:
            # 请求可能已送达服务器：非幂等操作不敢盲重试（见上方 docstring），直接失败退出。
            diag_log("agent.gateway.wechat.send_text", e)
            print(f"[wechat] 发送失败（不重试，非连接阶段错误）: "
                  f"{redact(f'{type(e).__name__}: {e}')}", flush=True)
            c = _clients.pop(channel_id, None)
            if c:
                try:
                    await c.stop()
                except Exception:
                    pass
            return False
    return False


# ── typing indicator（worker 端，2026-07-09 接入）──────────────────────────────
# worker.py 在 `set_state(THINKING)` 后调 `start_typing(payload)`、在真正发回复
# `_send(payload, reply_text)` 前调 `stop_typing(payload)`。每条消息一个 indicator，
# TypingIndicator 内部用 `asyncio.Task` 跑 keepalive，stop 时安全取消并发 OFF。

async def start_typing(payload: dict) -> TypingIndicator | None:
    """worker 端开始 typing 提示。返回 indicator 给调用方持有，结束时调 `stop_typing`。

    无 typing_ticket / 平台不是 wechat 时返回 None（退化 no-op，调用方判 None 即可）。
    """
    if payload.get("platform") != "wechat":
        return None
    typing_ticket = payload.get("typing_ticket") or ""
    if not typing_ticket:
        return None   # 没 ticket → 不发 typing（与 OpenClaw 退化一致）
    to_user_id = payload.get("platform_user_id") or ""
    if not to_user_id:
        return None
    channel_id = payload.get("channel_id")

    async def _send(status: int) -> None:
        try:
            client = await _client_for(channel_id)
            await client.send_typing(to_user_id, typing_ticket, status)
        except Exception as e:
            # 失败静默 log ——typing 是锦上添花，TypingIndicator 也会再吞一层，这里再兜底
            print(f"[wechat] send_typing({status}) 失败: {type(e).__name__}: {e}", flush=True)

    ind = TypingIndicator(_send, log=lambda m: print(f"[wechat] {m}", flush=True))
    await ind.start()
    return ind


async def stop_typing(ind: TypingIndicator | None) -> None:
    """worker 端结束 typing 提示。ind=None 时是 no-op（与 start_typing 退化分支对齐）。"""
    if ind is None:
        return
    await ind.stop()


# ── 媒体发送（worker 端，2026-07-09 接入）─────────────────────────────────────
# 流程（参考 OpenClaw messaging/send.ts）：
#   1. 本地 gen_aes_key + 加密明文
#   2. ILinkClient.get_upload_url(filekey, aeskey_hex, media_type, to_user_id, rawsize, md5, padded_size, no_need_thumb=True)
#   3. POST ciphertext 到 CDN upload_full_url（或 upload_param 拼接 URL）→ 响应头 x-encrypted-param 取下载参数
#   4. 拼 image_item / file_item 到 sendmessage.item_list，调 sendmessage
#
# 图片（item.type=2）：image_item.media.{encrypt_query_param, aes_key(base64), encrypt_type=1} + mid_size（密文字节）
# 文件（item.type=4）：file_item.media.{...} + file_name + len（明文字节，字符串）
# 注意 image_item 不带文件名，微信客户端从文件名/扩展名自己猜；file_item 必带 file_name

import httpx as _httpx
import urllib.parse as _urlparse
from agent.gateway import wechat_media_crypto as _media
from agent.gateway.wechat_client import (
    MESSAGE_ITEM_TYPE_IMAGE,
    MESSAGE_ITEM_TYPE_FILE,
    UPLOAD_MEDIA_TYPE_IMAGE,
    UPLOAD_MEDIA_TYPE_FILE,
)


class _CdnPermanentError(RuntimeError):
    """CDN 返回明确的 4xx 客户端错误——判定为永久失败，重试不会变好，不进重试循环。"""


async def _upload_to_cdn(client: ILinkClient, plaintext: bytes, media_type: int,
                         to_user_id: str) -> dict:
    """通用 CDN 上传：本地 AES-128-ECB 加密 → getuploadurl → POST ciphertext → 返回
    {download_param, aeskey_b64, filekey, padded_size, raw_size}。

    幂等前提：`filekey`/`ciphertext` 在本次调用内固定不变，同一份密文重发到同一个预签名
    URL 是安全的（P2-b §4-A），所以这里的重试循环可以放心重试非 4xx 失败。
    上游响应体/CDN 响应头可能回显签名参数，不能原样拼进异常消息外发/打日志（P2-b §5）——
    失败时原始响应只走受限诊断出口，异常消息只留静态文案 + 状态码。"""
    aeskey = _media.gen_aes_key()
    ciphertext = _media.encrypt_aes_ecb(plaintext, aeskey)
    filekey = _media.gen_filekey_hex()
    raw_size = len(plaintext)
    padded_size = len(ciphertext)
    md5 = _media.md5_hex(plaintext)

    upload_resp = await client.get_upload_url(body={
        "filekey": filekey,
        "aeskey": _media.aeskey_to_hex(aeskey),
        "media_type": media_type,
        "to_user_id": to_user_id,
        "rawsize": raw_size,
        "rawfilemd5": md5,
        "filesize": padded_size,
        "no_need_thumb": True,
    })
    upload_full_url = (upload_resp.get("upload_full_url") or "").strip() or None
    upload_param = upload_resp.get("upload_param")
    if not upload_full_url and not upload_param:
        diag_log_raw("agent.gateway.wechat.upload_to_cdn", f"getuploadurl 响应缺 URL: {upload_resp!r}")
        raise RuntimeError("getuploadurl 没返回可用的 upload URL")

    # 拼 CDN URL（参考 OpenClaw cdn/cdn-url.ts buildCdnUploadUrl）
    if upload_full_url:
        cdn_url = upload_full_url
    else:
        cdn_url = (f"{_media.CDN_BASE_URL}/upload"
                   f"?encrypted_query_param={_urlparse.quote(upload_param)}"
                   f"&filekey={_urlparse.quote(filekey)}")

    download_param = None
    last_err: BaseException | None = None
    for attempt in range(1, _media.UPLOAD_MAX_RETRIES + 1):
        try:
            async with _httpx.AsyncClient(timeout=30.0) as cli:
                r = await cli.post(
                    cdn_url,
                    content=ciphertext,
                    headers={"Content-Type": "application/octet-stream"},
                )
            # 4xx 客户端错误立即抛（不重试）；5xx/网络错误重试——本文件里判 4xx 不重试的
            # 既有做法，P2-b 把它当标杆抄到其余重试点。
            if 400 <= r.status_code < 500:
                diag_log_raw("agent.gateway.wechat.upload_to_cdn",
                              f"CDN 4xx status={r.status_code} body={r.text[:500]}")
                raise _CdnPermanentError(f"CDN 上传客户端错误 status={r.status_code}")
            r.raise_for_status()
            download_param = r.headers.get("x-encrypted-param")
            if not download_param:
                diag_log_raw("agent.gateway.wechat.upload_to_cdn",
                              f"CDN 响应缺 x-encrypted-param，headers={dict(r.headers)!r}")
                raise RuntimeError("CDN 上传响应缺 x-encrypted-param 头")
            break
        except _CdnPermanentError:
            raise   # 4xx：不重试，直接冒泡给调用方
        except Exception as e:
            last_err = e
            diag_log("agent.gateway.wechat.upload_to_cdn", e)
            print(f"[wechat] CDN 上传第 {attempt} 次失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
    if not download_param:
        raise RetryableError("wechat.cdn_upload_exhausted", "CDN 上传重试后仍失败",
                              cause=last_err, attempt=_media.UPLOAD_MAX_RETRIES)

    return {
        "download_param": download_param,
        "aeskey_b64": _media.aeskey_to_b64(aeskey),
        "filekey": filekey,
        "padded_size": padded_size,
        "raw_size": raw_size,
    }


async def send_image(to_user_id: str, image_bytes: bytes, context_token: str,
                     channel_id: str | None = None) -> bool:
    """给微信用户发图片（item.type=2）。iLink 必需 context_token。"""
    if not context_token:
        print("[wechat] 发图片缺 context_token，无法发送（iLink 端到端会话凭证）", flush=True)
        return False
    for attempt in (1, 2):
        try:
            client = await _client_for(channel_id)
            up = await _upload_to_cdn(client, image_bytes, UPLOAD_MEDIA_TYPE_IMAGE, to_user_id)
            item = {
                "type": MESSAGE_ITEM_TYPE_IMAGE,
                "image_item": {
                    "media": {
                        "encrypt_query_param": up["download_param"],
                        "aes_key": up["aeskey_b64"],
                        "encrypt_type": 1,
                    },
                    "mid_size": up["padded_size"],
                },
            }
            await client.sendmessage({
                "from_user_id": "",
                "to_user_id": to_user_id,
                "client_id": str(uuid.uuid4()),
                "message_type": 2,    # BOT
                "message_state": 2,   # FINISH
                "context_token": context_token,
                "item_list": [item],
            })
            return True
        except Exception as e:
            print(f"[wechat] 发图片第 {attempt} 次失败: {type(e).__name__}: {e}", flush=True)
            c = _clients.pop(channel_id, None)
            if c:
                try:
                    await c.stop()
                except Exception:
                    pass
    return False


async def send_file(to_user_id: str, file_bytes: bytes, file_name: str,
                    context_token: str, channel_id: str | None = None) -> bool:
    """给微信用户发文件附件（item.type=4）。file_name 要带扩展名，微信客户端靠它判类型。"""
    if not context_token:
        print("[wechat] 发文件缺 context_token，无法发送（iLink 端到端会话凭证）", flush=True)
        return False
    for attempt in (1, 2):
        try:
            client = await _client_for(channel_id)
            up = await _upload_to_cdn(client, file_bytes, UPLOAD_MEDIA_TYPE_FILE, to_user_id)
            item = {
                "type": MESSAGE_ITEM_TYPE_FILE,
                "file_item": {
                    "media": {
                        "encrypt_query_param": up["download_param"],
                        "aes_key": up["aeskey_b64"],
                        "encrypt_type": 1,
                    },
                    "file_name": file_name,
                    "len": str(up["raw_size"]),   # iLink 协议要求 len 是字符串
                },
            }
            await client.sendmessage({
                "from_user_id": "",
                "to_user_id": to_user_id,
                "client_id": str(uuid.uuid4()),
                "message_type": 2,
                "message_state": 2,
                "context_token": context_token,
                "item_list": [item],
            })
            return True
        except Exception as e:
            print(f"[wechat] 发文件第 {attempt} 次失败: {type(e).__name__}: {e}", flush=True)
            c = _clients.pop(channel_id, None)
            if c:
                try:
                    await c.stop()
                except Exception:
                    pass
    return False
