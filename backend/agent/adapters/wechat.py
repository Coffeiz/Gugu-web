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
      .venv/bin/python -m agent.adapters.wechat
"""
from __future__ import annotations

import asyncio
import os
import time

from app.core import redis as R
from agent.adapters.wechat_client import ILinkClient, DEFAULT_BASE_URL

STREAM = R.IM_INBOUND_STREAM
_ACK_COOLDOWN = 10.0    # 同一用户「收到啦」秒回冷却：连发多条/多图只 ack 一次，不刷屏（同 qq）
_last_ack: dict = {}    # from_user -> 上次 ack 时刻（单 bot 单网关进程，模块级即可）


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


def _img_ext_mime(data: bytes) -> tuple[str, str]:
    """按 magic bytes 判图片类型。"""
    if data[:3] == b"\xff\xd8\xff":                       return "jpg", "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":                  return "png", "image/png"
    if data[:4] == b"GIF8":                               return "gif", "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":     return "webp", "image/webp"
    return "jpg", "image/jpeg"   # 兜底当 jpg


async def _ingest_wechat_media(items: list, owner: str) -> list:
    """下载并解密微信图片项 → 暂存 → 返回 [attach_id]（照搬 qq `_ingest_qq_media` 模式）。
    iLink 媒体走 CDN（`image_item.media.full_url`）+ AES-128-ECB（key=`image_item.aeskey` hex）。
    语音（type==3）已在 `_handle_msg` 里用自带的 `voice_item.text` 转写文字处理，不会传进这里；
    file 项格式仍未知 → 留日志待补。"""
    import httpx
    from app.core import chat_attach
    out: list = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as cli:
        for it in items:
            img = it.get("image_item")
            if not img:
                other = [k for k, v in it.items() if k.endswith("_item") and v]
                if other:
                    print(f"[wechat] 暂不支持的媒体项（格式待补）: {other}", flush=True)
                continue
            aeskey = img.get("aeskey") or ""
            url = (img.get("media") or {}).get("full_url") or ""
            if not aeskey or not url:
                print("[wechat] 图片项缺 aeskey/full_url，跳过", flush=True)
                continue
            try:
                raw = (await cli.get(url)).content
                data = _aes128_ecb_decrypt(raw, bytes.fromhex(aeskey))
                ext, mime = _img_ext_mime(data)
                meta = await chat_attach.stage(owner, "微信图片", ext, mime, data, kind="image", platform="wechat")
                out.append(meta["attach_id"])
            except Exception as e:
                print(f"[wechat] 图片下载/解密失败: {type(e).__name__}: {e}", flush=True)
    return out


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

    # 即时反馈：先回一句「收到」，免得 agent 慢处理时用户干等（赶在 worker 之前）。**10s 冷却**：
    # 连发多条/多图只 ack 一次，不刷屏（真实回复由 worker 防抖合并成一条）。
    now = time.monotonic()
    if now - _last_ack.get(from_user, 0.0) > _ACK_COOLDOWN:
        _last_ack[from_user] = now
        try:
            await client.send_text(from_user, "收到啦，让我看看哈~", context_token)
        except Exception as e:
            print(f"[wechat] 即时反馈失败: {type(e).__name__}: {e}", flush=True)

    # 下载+解密+暂存媒体 → attach_id（图片走 _ingest_wechat_media；file/voice 暂留日志待补）
    attachments = await _ingest_wechat_media(non_text, owner) if non_text else []
    from agent import trace
    tid = trace.new_trace()
    # 隐私：不打印消息原文，只留结构+指纹（见 agent/logsafe.py），同 agent.traj 脱敏口径
    from agent import logsafe
    print(f"[wechat:{channel_id}] 收到 {from_user}: text_len={len(text)} fp={logsafe.fingerprint(text)} "
          f"att={len(attachments)} trace={tid}", flush=True)
    if not text and not attachments:   # 只有不支持的媒体、啥也没取到 → 不入队（agent 无内容）
        return
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
        "attachments": attachments,
        "trace_id": tid,                    # 全链路 trace：worker/工具日志同 id，grep 可串联
    }
    # TODO: 接 Intent Router 短路（仿 qq）
    try:
        await R.produce(STREAM, payload)
    except Exception as e:
        print(f"[wechat] 入队失败: {type(e).__name__}: {e}", flush=True)


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
                print(f"[wechat:{channel_id}] long-poll 异常: {type(e).__name__}: {e}，3s 后重试", flush=True)
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
    asyncio.run(_serve_async(channel_id, owner, bot_token, base_url))


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
    失败时丢弃缓存的 client、重建一次再试。"""
    if not context_token:
        print("[wechat] 发送缺 context_token，无法回复（iLink 端到端会话凭证）", flush=True)
        return False
    for attempt in (1, 2):
        try:
            client = await _client_for(channel_id)
            resp = await client.send_text(to_user_id, text, context_token)
            ret = (resp or {}).get("ret") if isinstance(resp, dict) else None
            if ret not in (0, None):   # iLink HTTP 200 但 ret≠0 = 业务失败（如 context_token 过期），不抛异常→在此暴露
                print(f"[wechat] sendmessage ret={ret}（消息可能未投递）resp={str(resp)[:200]}", flush=True)
            return True
        except Exception as e:
            print(f"[wechat] 发送失败(第{attempt}次): {type(e).__name__}: {e}", flush=True)
            c = _clients.pop(channel_id, None)
            if c:
                try:
                    await c.stop()
                except Exception:
                    pass
    return False


if __name__ == "__main__":
    serve()
