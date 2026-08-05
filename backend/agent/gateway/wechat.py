"""微信 iLink Bot 网关（个人微信，BYO 每用户自带 bot）。

和飞书/QQ 同模式（BYO + supervisor 子进程 + `im:inbound` 队列 + worker run_collect），
但 iLink 是 **HTTP long-poll**（非 WebSocket SDK）：本网关 `getupdates` 长轮询拉消息入队。
凭据是扫码拿的单个 `bot_token`（复用 `user_bots.app_secret` 存），`base_url` 复用 `app_id` 存。

凭据来源分两端（同 qq）：
  - 接收（本网关子进程）：supervisor 经环境变量注入 `WECHAT_*`（不走 argv，避免 ps 泄漏）
  - 发送（worker 进程）：按 bot id 现查 `user_bots`

⚠️ iLink **回复必须带入站消息给的 `context_token`**（端到端会话凭证）——入队 payload 带上
`context_token`，worker 回复时透传回 `send_text`。这是和飞书/QQ 唯一的接口差异。

启动（由 supervisor 拉起，注入 WECHAT_* 环境变量）：
    WECHAT_BOT_ID=.. WECHAT_BOT_TOKEN=.. WECHAT_BASE_URL=.. WECHAT_OWNER=.. \
      .venv/bin/python -m agent.gateway.wechat
"""
from __future__ import annotations

import asyncio
import os
import signal
import uuid

from app.core import redis as R
from app.core.errors import RetryableError
from app.core.redaction import diag_log, diag_log_raw, redact
from agent.im.media_ingress_wechat import (
    extract_quoted as _extract_quoted,
    ingest_media as _ingest_wechat_media_impl,
    media_url as _wechat_media_url,
)
from agent.gateway.wechat_client import ILinkClient, DEFAULT_BASE_URL
from agent.gateway.wechat_config_cache import WeixinConfigManager
from agent.gateway.wechat_typing import TypingIndicator

STREAM = R.IM_INBOUND_STREAM

# 网关进程内 per-user typing_ticket 缓存（2026-07-09 接入 iLink typing 接口）
# 单 bot 单网关进程 → 模块级单例天然 per-bot 隔离；多 user 共享同一 manager
_config_managers: dict[str, WeixinConfigManager] = {}


def _get_config_manager(channel_id: str) -> WeixinConfigManager:
    """按 channel_id 取（首次懒创建）/ 取缓存的 WeixinConfigManager。

    网关子进程的 bot_token 由 supervisor 注入到 `WECHAT_BOT_TOKEN` 环境变量，
    所以这里直接读环境变量构造 manager（不用像 worker 那样走 user_bots 现查）。
    """
    if channel_id not in _config_managers:
        import os
        bot_token = os.environ.get("WECHAT_BOT_TOKEN", "")
        base_url = os.environ.get("WECHAT_BASE_URL", "") or DEFAULT_BASE_URL
        _config_managers[channel_id] = WeixinConfigManager(
            {"bot_token": bot_token, "base_url": base_url},
            log=lambda msg: print(msg, flush=True),
        )
    return _config_managers[channel_id]


def _aes128_ecb_decrypt(raw: bytes, key: bytes) -> bytes:
    """iLink 媒体解密：AES-128-ECB（key=16B）+ PKCS7 去填充。"""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    dec = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    out = dec.update(raw) + dec.finalize()
    if out:
        pad = out[-1]
        if 1 <= pad <= 16 and out[-pad:] == bytes([pad]) * pad:
            out = out[:-pad]
    return out


async def _ingest_wechat_media(items: list, owner: str) -> list:
    return await _ingest_wechat_media_impl(items, owner, _aes128_ecb_decrypt)


# ── 接收（网关子进程，long-poll）────────────────────────────────────────────────
async def _handle_msg(msg: dict, channel_id: str, owner: str, client) -> None:
    if msg.get("message_type") != 1:   # 只处理 用户→bot（2=bot 自己发的，跳过，否则自问自答）
        return
    from_user = msg.get("from_user_id", "")
    context_token = msg.get("context_token", "")
    group_id = msg.get("group_id", "")
    items = msg.get("item_list") or []
    text = "".join(
        (it.get("text_item") or {}).get("text", "")
        for it in items
    ).strip()
    # 语音消息（type==3）：iLink 自带 ASR 转写在 item.voice_item.text，直接当对话文本注入，
    # 不用像图片那样走 CDN + AES-128-ECB 下载解密（微信官方已经转好文字了）。转写偶尔为空
    # （ASR 失败/听不清）给个兜底提示，不静默丢消息。
    voice_parts = []
    for it in items:
        if it.get("type") != 3:
            continue
        vt = (it.get("voice_item") or {}).get("text", "").strip()
        voice_parts.append(
            f"🎤 用户发来一条语音（已转文字）：「{vt}」。请直接听懂这段话并自然回应——"
            f"这是对话内容，不是文件，别问「要不要保存」这类话。"
            if vt else "🎤 用户发来一条语音，但转写失败/没听清，麻烦让用户用文字重新说一下。"
        )
    if voice_parts:
        text = (text + "\n\n" if text else "") + "\n\n".join(voice_parts)
    # 非文本项（图片/文件）：iLink 媒体 AES-128-ECB + CDN，下载解密暂存（图片已支持，见 _ingest）。
    # 语音（type==3）已在上面转成文本处理，这里排除掉，不再走媒体暂存流程。
    non_text = [it for it in items if it.get("type") not in (1, 3)]
    if not from_user:
        return
    if not text and not non_text:   # 真空消息
        return

    # 引用消息：把被引用原文单独塞 quoted_text，引用图片等媒体继续按普通附件入队。
    quoted_text = None
    quoted_items = []
    has_quote = False
    for it in items:
        quoted, quoted_media = _extract_quoted(it.get("ref_msg"))
        if quoted or quoted_media:
            quoted_text = quoted
            quoted_items = quoted_media
            has_quote = True
            break

    # 下载+解密+暂存媒体：当前消息附件 + 引用里的图片附件一并入队。
    media_items = non_text + quoted_items
    attachments = await _ingest_wechat_media(media_items, owner) if media_items else []
    from agent import trace
    tid = trace.new_trace()
    # 隐私：不打印消息原文，只留结构+指纹（见 agent/logsafe.py），同 agent.traj 脱敏口径
    from agent import logsafe
    print(f"[wechat:{channel_id}] 收到 {from_user}: text_len={len(text)} fp={logsafe.fingerprint(text)} "
          f"att={len(attachments)} quoted={has_quote} trace={tid}", flush=True)
    if not text and not attachments:   # 只有不支持的媒体、啥也没取到 → 不入队（agent 无内容）
        return
    # typing_ticket（per-user, 24h 有效）——同步等 + 超时兜底，避免 race condition
    # （OpenClaw 做法也是同步 await，但 Gugu-web 这里加 500ms 上限防网络抖动拖慢 supervisor 拉消息节奏）
    # 拿不到时 worker 端按空 ticket 走"不发 typing"分支（与 OpenClaw 退化策略一致）
    typing_ticket = ""
    try:
        cfg = await asyncio.wait_for(
            _get_config_manager(channel_id).get_for_user(from_user, context_token),
            timeout=0.5,
        )
        typing_ticket = cfg.get("typing_ticket", "") or ""
    except Exception as e:
        # `asyncio.TimeoutError` 就是内建 `TimeoutError`，已被 `Exception` 覆盖，原元组冗余
        # （P2-b §6 反模式）。best-effort：拿不到 ticket 退化成不发 typing，不挡入队主流程。
        diag_log("agent.gateway.wechat.typing_ticket", e)
        print(f"[wechat] typing_ticket 获取超时/失败（不影响主流程）: "
              f"{redact(f'{type(e).__name__}: {e}')}", flush=True)

    payload = {
        "platform": "wechat",
        "channel_id": channel_id,
        "owner_user_id": owner,             # BYO：bot 归属即用户，worker 直接用
        "platform_user_id": from_user,      # 微信用户 id（xxx@im.wechat）
        "message_id": context_token,        # iLink 无独立 msg_id，用 context_token 作标识/去重
        "chat_type": "group" if group_id else "c2c",
        "wechat_group_id": group_id,
        "context_token": context_token,     # ⚠️ iLink 回复必需，worker 透传回 send_text
        "text": text,
        "quoted_text": quoted_text,
        "attachments": attachments,
        "trace_id": tid,                    # 全链路 trace：worker/工具日志同 id，grep 可串联
        "typing_ticket": typing_ticket,     # 空 = 不发 typing（worker 端按空 ticket 退化）
    }
    # TODO: 接 Intent Router 短路（仿 qq）
    try:
        from agent.im.models import normalize_payload
        payload = normalize_payload(payload)
        await R.produce(STREAM, payload)
    except Exception as e:
        # 不重试：Redis stream XADD 没有幂等键，重推同一 payload 会造成 worker 端重复处理这条
        # 消息（非幂等写，P2-b §4-A 幂等前提）。丢这一条比重复处理更安全，原始异常留受限出口
        # 供排查，可见日志只留脱敏摘要。
        diag_log("agent.gateway.wechat.enqueue", e)
        print(f"[wechat] 入队失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)


async def _serve_async(channel_id: str, owner: str, bot_token: str, base_url: str) -> None:
    client = ILinkClient(bot_token, base_url)
    await client.start()
    print(f"[wechat:{channel_id}] 网关就绪（owner={owner}），long-poll 中…", flush=True)
    cursor = ""
    try:
        while True:
            try:
                resp = await client.getupdates(cursor)
                cursor = resp.get("get_updates_buf", cursor) or cursor
                for msg in (resp.get("msgs") or []):
                    await _handle_msg(msg, channel_id, owner, client)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # getupdates 是幂等读（long-poll 拉取，游标没推进就不会丢/重消息），无界重试是
                # 安全的——不区分 4xx/5xx：哪怕是永久性错误（如 token 失效），网关也应该继续
                # 挂着重试而不是退出进程（同 openclaw 网关退化策略），只是每次都留诊断记录。
                diag_log("agent.gateway.wechat.long_poll", e)
                print(f"[wechat:{channel_id}] long-poll 异常: "
                      f"{redact(f'{type(e).__name__}: {e}')}，3s 后重试", flush=True)
                await asyncio.sleep(3)
    finally:
        await client.stop()


def serve() -> None:
    channel_id = os.environ.get("WECHAT_BOT_ID", "")
    owner = os.environ.get("WECHAT_OWNER", "")
    bot_token = os.environ.get("WECHAT_BOT_TOKEN", "")
    base_url = os.environ.get("WECHAT_BASE_URL", "") or DEFAULT_BASE_URL
    if not bot_token:
        raise SystemExit("缺少 WECHAT_BOT_TOKEN 环境变量（应由 supervisor 注入）。")
    print(f"[wechat:{channel_id}] 网关启动…", flush=True)
    # 注册 SIGTERM handler——supervisor 发 SIGTERM 时优雅退出（先 notifystop、再退出），
    # 避免上游服务器侧 long-poll 悬挂等 35s 超时才发现连接断了。
    # asyncio.run 跑在子线程没法直接装 signal handler，所以通过 main_thread_loop 桥接：
    # SIGTERM 到达时把 notifystop 调度进 running loop 跑（独立 timeout，不受主退出流程影响）。
    loop_holder: dict = {}

    def _on_sigterm(signum, frame):
        loop = loop_holder.get("loop")
        if loop is None or loop.is_closed():
            return
        # notifystop 用独立 timeout（参考 OpenClaw api/api.ts notifyStop 注释——「使用独立超时，
        # 这样 OpenClaw 已经 abort long-poll 后请求也能完成」），这里 create_task 让它在 loop 里跑
        async def _notify():
            try:
                cli = ILinkClient(bot_token=bot_token, base_url=base_url)
                await cli.start()
                try:
                    await asyncio.wait_for(cli.notify_stop(), timeout=5.0)
                finally:
                    await cli.stop()
                print(f"[wechat:{channel_id}] notifystop 已发", flush=True)
            except Exception as e:
                # best-effort：进程反正要退出了，通知上游失败也不影响本进程收尾。
                diag_log("agent.gateway.wechat.notify_stop", e)
                print(f"[wechat:{channel_id}] notifystop 失败（忽略）: "
                      f"{redact(f'{type(e).__name__}: {e}')}", flush=True)

        try:
            asyncio.run_coroutine_threadsafe(_notify(), loop)
        except Exception:
            pass

    signal.signal(signal.SIGTERM, _on_sigterm)
    signal.signal(signal.SIGINT, _on_sigterm)

    asyncio.run(_serve_async_with_start_notify(channel_id, owner, bot_token, base_url, loop_holder))


async def _serve_async_with_start_notify(channel_id: str, owner: str, bot_token: str,
                                          base_url: str, loop_holder: dict) -> None:
    """在主 loop 里跑：先 notifystart → 然后把 loop 引用交给 SIGTERM handler → 跑原 long-poll 主循环。"""
    loop_holder["loop"] = asyncio.get_running_loop()
    try:
        cli = ILinkClient(bot_token=bot_token, base_url=base_url)
        await cli.start()
        try:
            await cli.notify_start()
            print(f"[wechat:{channel_id}] notifystart 已发", flush=True)
        except Exception as e:
            # best-effort：notifystart 只是告知上游，失败不该挡后面 long-poll 主循环启动。
            diag_log("agent.gateway.wechat.notify_start", e)
            print(f"[wechat:{channel_id}] notifystart 失败（不影响主流程）: "
                  f"{redact(f'{type(e).__name__}: {e}')}", flush=True)
        finally:
            await cli.stop()
    except Exception as e:
        # best-effort：整个启动通知阶段失败也不该阻止网关进主循环收消息。
        diag_log("agent.gateway.wechat.start_notify_phase", e)
        print(f"[wechat:{channel_id}] 启动通知阶段异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)

    await _serve_async(channel_id, owner, bot_token, base_url)


# ── 发送（worker 用，按 bot id 现查 DB 取 bot_token，缓存 client）──────────────────
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
    新 `client_id`（见 wechat_client.py），重试之间没有共享的幂等键——如果请求其实已经送达
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


if __name__ == "__main__":
    serve()
