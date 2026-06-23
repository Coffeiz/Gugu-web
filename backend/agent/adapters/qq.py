"""QQ 官方机器人网关（单聊 C2C，BYO 每用户自带 bot）。

和飞书长连接同模式：botpy WebSocket outbound 主动连，**不需要公网**（备案前也能用）。
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

import os

import botpy
from botpy.message import C2CMessage

from app.core import redis as R

STREAM = R.IM_INBOUND_STREAM


# ── 接收（网关子进程，凭据/归属从 env 注入）──
class _GuguQQClient(botpy.Client):
    def __init__(self, channel_id: str, owner_user_id: str, **kw):
        super().__init__(**kw)
        self._channel_id = channel_id
        self._owner = owner_user_id

    async def on_ready(self):
        print(f"[qq:{self._channel_id}] 网关就绪（owner={self._owner}），WebSocket 长连接中…", flush=True)

    async def on_c2c_message_create(self, message: C2CMessage):
        text = (message.content or "").strip()
        openid = message.author.user_openid if message.author else None
        # 用户发来文件：先瞬发一句「收到」（在下载/暂存/入队之前，赶在 worker 慢处理之前给即时反馈）
        if getattr(message, "attachments", None):
            try:
                await _post(self.api, openid, "文件收到啦，让我看看~", message.id)
            except Exception as e:
                print(f"[qq] 文件 ack 失败: {type(e).__name__}: {e}", flush=True)
        # 下载 → 暂存 → 走 attachments（和飞书同一套）
        attachments = await _ingest_qq_media(message, self._owner)
        if not text and not attachments:
            return
        payload = {
            "platform": "qqbot",
            "channel_id": self._channel_id,
            "owner_user_id": self._owner,      # BYO：bot 归属即用户，worker 直接用
            "platform_user_id": openid,
            "message_id": message.id,
            "chat_type": "c2c",
            "text": text,
            "attachments": attachments,
        }
        print(f"[qq:{self._channel_id}] 收到 {openid}: text={text[:40]!r} att={len(attachments)}", flush=True)
        try:
            await R.produce(STREAM, payload)
        except Exception as e:
            print(f"[qq] 入队失败: {type(e).__name__}: {e}", flush=True)


async def _ingest_qq_media(message: C2CMessage, owner: str) -> list:
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
                meta = await chat_attach.stage(owner, name, ext, mime, data)
                out.append(meta["attach_id"])
            except Exception as e:
                print(f"[qq] 暂存附件出错: {type(e).__name__}: {e}", flush=True)
    return out


def serve() -> None:
    app_id = os.environ.get("QQ_APP_ID", "")
    secret = os.environ.get("QQ_APP_SECRET", "")
    sandbox = os.environ.get("QQ_SANDBOX", "0") in ("1", "true", "True")
    channel_id = os.environ.get("QQ_BOT_ID", "")
    owner = os.environ.get("QQ_OWNER", "")
    if not app_id or not secret:
        raise SystemExit("缺少 QQ_APP_ID / QQ_APP_SECRET 环境变量（应由 supervisor 注入）。")
    intents = botpy.Intents(public_messages=True)   # C2C / 群 公域消息
    client = _GuguQQClient(channel_id, owner, intents=intents, is_sandbox=sandbox, bot_log=False)
    print(f"[qq:{channel_id}] 网关启动（sandbox={sandbox}）…", flush=True)
    client.run(appid=app_id, secret=secret)   # 同步阻塞，botpy 自带断线重连


# ── 发送（worker 用，按 bot id 现查 DB 取凭据，缓存 BotAPI）──
_apis: dict = {}

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


async def _api_for(channel_id: str):
    if channel_id not in _apis:
        from botpy import Token
        from botpy.api import BotAPI
        from botpy.http import BotHttp
        app_id, secret, sandbox = await _creds_by_id(channel_id)
        if not app_id:
            raise RuntimeError(f"user_bot {channel_id} 不存在或无凭据")
        http = BotHttp(timeout=20, is_sandbox=sandbox, app_id=app_id, secret=secret)
        await http.login(Token(app_id, secret))   # 取 access_token
        _apis[channel_id] = BotAPI(http)
    return _apis[channel_id]


def _markdown_blocked(exc: Exception) -> bool:
    """该 bot 没开通原生 markdown 权限的报错（回退纯文本）。"""
    s = str(exc)
    return ("50056" in s or "40034012" in s or "不允许发送原生 markdown" in s)


async def _post(api, openid: str, text: str, msg_id: str | None):
    """先发原生 markdown(msg_type=2) 让 QQ 渲染；该 bot 无 md 权限则回退纯文本(msg_type=0)。
    每次发都取新 msg_seq，避免重复 seq 被去重。"""
    try:
        await api.post_c2c_message(openid=openid, msg_type=2,
                                   markdown={"content": text}, msg_id=msg_id, msg_seq=await _next_seq(msg_id))
    except Exception as me:
        if not _markdown_blocked(me):
            raise
        await api.post_c2c_message(openid=openid, msg_type=0,
                                   content=text, msg_id=msg_id, msg_seq=await _next_seq(msg_id))


async def send_c2c(openid: str, text: str, msg_id: str | None = None,
                   channel_id: str | None = None) -> bool:
    """给指定用户发 C2C 被动回复（带原 msg_id）。token 过期等异常时重建一次再试。"""
    for attempt in (1, 2):
        try:
            api = await _api_for(channel_id)
            await _post(api, openid, text, msg_id)
            return True
        except Exception as e:
            print(f"[qq] 发送失败(第{attempt}次): {type(e).__name__}: {e}", flush=True)
            _apis.pop(channel_id, None)   # 丢弃缓存，下次重新 login
    return False


# ── 发文件（worker 用）。C2C 私聊支持图片(file_type=1)和文件(file_type=4)；群聊不支持发文件 ──
_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}


async def send_file(openid: str, data: bytes | None, name: str, ext: str,
                    channel_id: str | None = None, msg_id: str | None = None,
                    url: str | None = None) -> bool:
    """给 QQ 用户发图片/文件。**有 url（OSS 公网/签名地址）→ URL 模式让 QQ 自己抓（无体积限制）；
    否则 base64 上传 data（本地存储用，受 ~10MB 限制）**。C2C 图片→file_type 1、其余文件→4。"""
    import base64
    from botpy.http import Route
    import asyncio
    ext_l = (ext or "").lower()
    is_img = ext_l in _IMAGE_EXTS
    file_type = 1 if is_img else 4
    fname = f"{name}.{ext_l}" if ext_l else name
    b64 = base64.b64encode(data).decode() if (data is not None and not url) else None
    # 上传 inner proxy 偶发抖动，多重试几次（每次取新 msg_seq，避免去重）
    for attempt in range(1, 5):
        try:
            api = await _api_for(channel_id)
            # 1) 上传到 QQ 富媒体，拿 file_info（url 模式让 QQ 抓；否则 base64 file_data）
            body = {"file_type": file_type, "srv_send_msg": False}
            if url:
                body["url"] = url
            else:
                body["file_data"] = b64
            if not is_img:
                body["file_name"] = fname
            route = Route("POST", "/v2/users/{openid}/files", openid=openid)
            media = await api._http.request(route, json=body)
            file_info = media.get("file_info") if isinstance(media, dict) else getattr(media, "file_info", None)
            if not file_info:
                print(f"[qq] 富媒体上传无 file_info: {media}", flush=True)
                return False
            # 2) 发媒体消息（被动回复带 msg_id；文件用 content 让 QQ 显示文件名）
            kw = {"content": fname} if not is_img else {}
            await api.post_c2c_message(openid=openid, msg_type=7,
                                      media={"file_info": file_info}, msg_id=msg_id, msg_seq=await _next_seq(msg_id), **kw)
            return True
        except Exception as e:
            s = str(e)
            print(f"[qq] 发文件失败(第{attempt}次): {type(e).__name__}: {e}", flush=True)
            # token 失效才重建 api；inner proxy 等抖动直接重试
            if "token" in s.lower() or "code: 401" in s:
                _apis.pop(channel_id, None)
            if attempt < 4:
                await asyncio.sleep(0.6 * attempt)
    return False


if __name__ == "__main__":
    serve()
