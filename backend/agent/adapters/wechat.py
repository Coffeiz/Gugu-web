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

from app.core import redis as R
from agent.adapters.wechat_client import ILinkClient, DEFAULT_BASE_URL

STREAM = R.IM_INBOUND_STREAM


# ── 接收（网关子进程，long-poll）────────────────────────────────────────────────
async def _handle_msg(msg: dict, channel_id: str, owner: str, client) -> None:
    if msg.get("message_type") != 1:   # 只处理 用户→bot（2=bot 自己发的，跳过，否则自问自答）
        return
    from_user = msg.get("from_user_id", "")
    context_token = msg.get("context_token", "")
    group_id = msg.get("group_id", "")
    text = "".join(
        (it.get("text_item") or {}).get("text", "")
        for it in (msg.get("item_list") or [])
    ).strip()
    if not from_user or not text:   # MVP 只处理文本（图片/语音/文件后补）
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
        "attachments": [],
    }
    print(f"[wechat:{channel_id}] 收到 {from_user}: {text[:40]!r}", flush=True)
    # 即时反馈：先回一句「收到」，免得 agent 慢处理时用户在微信干等没动静（赶在 worker 之前）。
    # 复用入站消息的 context_token；ack + 正式回复共 2 条，远低于 iLink 每 token 的回复上限。
    try:
        await client.send_text(from_user, "收到啦，让我看看哈~", context_token)
    except Exception as e:
        print(f"[wechat] 即时反馈失败: {type(e).__name__}: {e}", flush=True)
    # TODO: 接 Intent Router 短路（仿 qq：任务进行中的「还在吗/算了/嗯」网关层处理）；先直接入队
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
            await client.send_text(to_user_id, text, context_token)
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
