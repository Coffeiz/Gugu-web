"""QQ 官方机器人网关（单聊 C2C + 群聊，BYO 每用户自带 bot）。

群聊需要在「接入咕咕」页开启 group_chat_enabled 开关；QQ 官方 SDK 层面群消息本就只有
@ 了机器人才会触发事件（没有"收全部群消息"的能力），group_requires_at 对 QQ 恒为 True。

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
import time
from typing import Any, Dict, List, Optional

import botpy
from botpy.message import C2CMessage, GroupMessage
from botpy.message import Message as _BaseMessage

from app.core import redis as R

STREAM = R.IM_INBOUND_STREAM
_ACK_COOLDOWN = 10.0   # 同一用户「文件收到啦」秒回的冷却秒数：连发多图/文件只 ack 一次，不刷屏

# ── monkey-patch：让 botpy 消息对象保留原始 payload（用于引用消息解析）──
_orig_base_init = _BaseMessage.__init__
def _patched_base_init(self, api, event_id, data):
    _orig_base_init(self, api, event_id, data)
    self._raw_data = data
_BaseMessage.__init__ = _patched_base_init


def _find_quoted_element(raw_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """从原始 payload 中找到被引用的消息元素。

    QQ 的 msg_elements 列表包含当前会话的上下文消息，其中用户引用的消息
    通过 message_scene.ext 里的 ref_msg_idx 定位。
    """
    msg_elements: List[Dict[str, Any]] = raw_data.get("msg_elements") or []
    if not msg_elements:
        return None

    scene_ext = (raw_data.get("message_scene") or {}).get("ext") or []
    ref_idx = ""
    for entry in scene_ext:
        if isinstance(entry, str) and entry.startswith("ref_msg_idx="):
            ref_idx = entry[len("ref_msg_idx="):]
            break

    if ref_idx:
        for elem in msg_elements:
            if elem.get("msg_idx") == ref_idx:
                return elem

    # fallback：返回第一条不是自己的消息
    msg_id = raw_data.get("id", "")
    for elem in msg_elements:
        if elem.get("msg_id") != msg_id:
            return elem
    return None


def _extract_quoted_text(raw_data: Dict[str, Any]) -> Optional[str]:
    """从原始 payload 提取引用消息的文本内容，用于拼接到 LLM 输入。"""
    elem = _find_quoted_element(raw_data)
    if not elem:
        return None
    content = (elem.get("content") or "").strip()
    # 转义 HTML 实体（QQ 消息文本中的 &lt; &gt; &amp;）
    content = content.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    return content or None


# ── 接收（网关子进程，凭据/归属从 env 注入）──
class _GuguQQClient(botpy.Client):
    def __init__(self, channel_id: str, owner_user_id: str, **kw):
        super().__init__(**kw)
        self._channel_id = channel_id
        self._owner = owner_user_id
        self._last_ack: dict = {}   # openid -> 上次「文件收到」秒回的时刻；连发多图只 ack 一次

    async def on_ready(self):
        print(f"[qq:{self._channel_id}] 网关就绪（owner={self._owner}），WebSocket 长连接中…", flush=True)

    async def on_c2c_message_create(self, message: C2CMessage):
        text = (message.content or "").strip()
        openid = message.author.user_openid if message.author else None
        # 引用消息解析：从原始 payload 中提取被引用的消息文本
        raw_data = getattr(message, "_raw_data", {})
        quoted_text = _extract_quoted_text(raw_data)
        if quoted_text:
            text = f"[引用消息: {quoted_text}]\n{text}"
        # 用户发来文件：先瞬发一句「收到」（在下载/暂存/入队之前，赶在 worker 慢处理之前给即时反馈）。
        # **连发多图/文件只 ack 一次**（10s 冷却）——否则一张图一条「文件收到啦」会刷屏；真正的回复由
        # worker 防抖合并成一条。
        if getattr(message, "attachments", None):
            now = time.monotonic()
            if now - self._last_ack.get(openid, 0.0) > _ACK_COOLDOWN:
                self._last_ack[openid] = now
                try:
                    await _post(self.api, openid, "文件收到啦，让我看看~", message.id)
                except Exception as e:
                    print(f"[qq] 文件 ack 失败: {type(e).__name__}: {e}", flush=True)
        # 下载 → 暂存 → 走 attachments（和飞书同一套）
        attachments = await _ingest_qq_media(message, self._owner)
        if not text and not attachments:
            return
        from agent import trace
        tid = trace.new_trace()
        payload = {
            "platform": "qqbot",
            "channel_id": self._channel_id,
            "owner_user_id": self._owner,      # BYO：bot 归属即用户，worker 直接用
            "platform_user_id": openid,
            "message_id": message.id,
            "chat_type": "c2c",
            "text": text,
            "attachments": attachments,
            "trace_id": tid,                   # 全链路 trace：worker/工具日志同 id，grep 可串联
        }
        # 隐私：不打印消息原文（Debug 面板可搜索，聊天内容不该落进可查阅日志），只留结构+指纹——
        # 长度/附件数/trace 够排查「有没有收到、收没收到附件」，指纹（不可逆）够排查「是不是被
        # 重复处理了」，同 agent.traj 的脱敏口径。
        from agent import logsafe
        print(f"[qq:{self._channel_id}] 收到 {openid}: text_len={len(text)} fp={logsafe.fingerprint(text)} "
              f"att={len(attachments)} trace={tid}", flush=True)

        # Intent Router：纯文本消息据当前状态短路——任务进行中的「还在吗/算了/嗯」网关直接处理、不入队
        if not attachments:
            from agent import router, runtime_state as rtstate
            dec = router.decide(text, await rtstate.get_state("qqbot", openid),
                                await rtstate.is_awaiting("qqbot", openid))
            if dec["action"] == "drop":
                return
            if dec["action"] in ("reply", "cancel"):
                if dec["action"] == "cancel":
                    await rtstate.request_cancel("qqbot", openid)
                try:
                    await _post(self.api, openid, dec["reply"], message.id)
                except Exception as e:
                    print(f"[qq] 短路回复失败: {type(e).__name__}: {e}", flush=True)
                return

        try:
            await R.produce(STREAM, payload)
        except Exception as e:
            print(f"[qq] 入队失败: {type(e).__name__}: {e}", flush=True)

    async def on_group_at_message_create(self, message: GroupMessage):
        """群消息（QQ 官方 SDK 只有群里 @ 了机器人才会触发这个事件，没有"收全部群消息"的能力）。
        群聊要单独一个开关（user_bots.group_chat_enabled）——**每条群消息都现查一次 DB**（而不是
        启动时从 env 注入一次），这样用户在「接入咕咕」页切换开关立刻生效，不用重启这条网关子进程。"""
        group_enabled, _requires_at = await _group_settings(self._channel_id)
        if not group_enabled:
            return
        text = (message.content or "").strip()
        group_openid = message.group_openid
        member_openid = message.author.member_openid if message.author else None
        # 引用消息解析：从原始 payload 中提取被引用的消息文本
        raw_data = getattr(message, "_raw_data", {})
        quoted_text = _extract_quoted_text(raw_data)
        if quoted_text:
            text = f"[引用消息: {quoted_text}]\n{text}"
        attachments = await _ingest_qq_media(message, self._owner)
        if not text and not attachments:
            return
        from agent import trace
        tid = trace.new_trace()
        payload = {
            "platform": "qqbot",
            "channel_id": self._channel_id,
            "owner_user_id": self._owner,      # BYO：bot 归属即用户，worker 直接用
            "platform_user_id": member_openid,  # 群内发言人（用于会话/状态按用户维度隔离）
            "chat_id": group_openid,            # 回复路由用（区别于 c2c 直接用 platform_user_id）
            "message_id": message.id,
            "chat_type": "group",
            "text": text,
            "attachments": attachments,
            "trace_id": tid,
        }
        from agent import logsafe
        print(f"[qq:{self._channel_id}] 收到群 {group_openid} 内 {member_openid}: "
              f"text_len={len(text)} fp={logsafe.fingerprint(text)} att={len(attachments)} trace={tid}", flush=True)

        if not attachments:
            from agent import router, runtime_state as rtstate
            dec = router.decide(text, await rtstate.get_state("qqbot", member_openid),
                                await rtstate.is_awaiting("qqbot", member_openid))
            if dec["action"] == "drop":
                return
            if dec["action"] in ("reply", "cancel"):
                if dec["action"] == "cancel":
                    await rtstate.request_cancel("qqbot", member_openid)
                try:
                    await _post_group(self.api, group_openid, dec["reply"], message.id)
                except Exception as e:
                    print(f"[qq] 群短路回复失败: {type(e).__name__}: {e}", flush=True)
                return

        try:
            await R.produce(STREAM, payload)
        except Exception as e:
            print(f"[qq] 群消息入队失败: {type(e).__name__}: {e}", flush=True)


async def _ingest_qq_media(message: C2CMessage | GroupMessage, owner: str) -> list:
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


async def _group_settings(bot_id: str) -> tuple[bool, bool]:
    """网关接收端用：按 user_bots.id 现查 (group_chat_enabled, group_requires_at)。
    每条群消息都查一次而不是启动时缓存，换来「切开关立即生效、不用重启网关子进程」。"""
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import UserBot
    async with _sess._SessionLocal() as db:
        b = await db.get(UserBot, int(bot_id))
        if not b:
            return False, True
        return b.group_chat_enabled, b.group_requires_at


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


async def _post_group(api, group_openid: str, text: str, msg_id: str | None):
    """群聊版 _post：先发原生 markdown，该 bot 无 md 权限则回退纯文本。"""
    try:
        await api.post_group_message(group_openid=group_openid, msg_type=2,
                                     markdown={"content": text}, msg_id=msg_id, msg_seq=await _next_seq(msg_id))
    except Exception as me:
        if not _markdown_blocked(me):
            raise
        await api.post_group_message(group_openid=group_openid, msg_type=0,
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


async def send_group(group_openid: str, text: str, msg_id: str | None = None,
                     channel_id: str | None = None) -> bool:
    """给指定群发被动回复（带原 msg_id）。token 过期等异常时重建一次再试。"""
    for attempt in (1, 2):
        try:
            api = await _api_for(channel_id)
            await _post_group(api, group_openid, text, msg_id)
            return True
        except Exception as e:
            print(f"[qq] 群发送失败(第{attempt}次): {type(e).__name__}: {e}", flush=True)
            _apis.pop(channel_id, None)
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
