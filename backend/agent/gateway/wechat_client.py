"""微信 iLink Bot API 的异步 HTTP 客户端。

iLink 是微信官方给**个人微信号**的 bot 接入（`https://ilinkai.weixin.qq.com`，
扫码授权拿 bot_token，无需企业资质、非逆向、官方 HTTP API）。协议参考微信官方
iLink Bot HTTP API（weixin.qq.com/cgi-bin/readtemplate?t=ilink/chatbot）。

## 已实现端点
- 登录：`get_bot_qrcode` / `get_qrcode_status` → 拿 `bot_token` / `baseurl`
- 收消息：`getupdates`（long-poll，服务端最多挂 ~35s）
- 发消息：`sendmessage`（必须带入站消息的 `context_token`）
- 媒体上传：`getuploadurl`（CDN 预签名 URL）+ AES-128-ECB 加密（见 `wechat_media.py`）
- **typing 状态**：`getconfig` 拿 `typing_ticket` / `sendtyping` 发「正在输入」（2026-07-09）
- **通道通知**：`msg/notifystart` / `msg/notifystop`（网关启停时告知上游）

## 与 send_text 的关系
send_text 是 sendmessage 的便捷封装（构造好 item_list 后调 sendmessage）。
"""
from __future__ import annotations

import base64
import secrets
import uuid
from typing import Any, Optional

import httpx

DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
CHANNEL_VERSION = "2.0.1"
_GETUPDATES_TIMEOUT = 45.0    # long-poll 服务端最多挂 ~35s，留余量
_DEFAULT_TIMEOUT = 15.0
_QRCODE_STATUS_TIMEOUT = 60.0

# typing 状态（与 OpenClaw api/types.ts 的 TypingStatus 一致）
TYPING_ON = 1
TYPING_OFF = 2

# sendmessage.item_list[].type（消息项类型，与 item_type 字段对齐）
# 注意跟 UploadMediaType 不一样——后者是喂给 getuploadurl.media_type 的
MESSAGE_ITEM_TYPE_TEXT = 1
MESSAGE_ITEM_TYPE_IMAGE = 2
MESSAGE_ITEM_TYPE_VOICE = 3
MESSAGE_ITEM_TYPE_FILE = 4
MESSAGE_ITEM_TYPE_VIDEO = 5

# getuploadurl.media_type（媒体上传分类）
UPLOAD_MEDIA_TYPE_IMAGE = 1
UPLOAD_MEDIA_TYPE_VIDEO = 2
UPLOAD_MEDIA_TYPE_FILE = 3
UPLOAD_MEDIA_TYPE_VOICE = 4


def make_headers(bot_token: str = "") -> dict[str, str]:
    """iLink 请求头。`X-WECHAT-UIN` 防重放（每请求随机 uint32 的 base64），有 token 时带 Bearer。"""
    uin = base64.b64encode(str(secrets.randbelow(0xFFFFFFFF)).encode()).decode()
    headers = {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "X-WECHAT-UIN": uin,
    }
    if bot_token:
        headers["Authorization"] = f"Bearer {bot_token}"
    return headers


class ILinkClient:
    """微信 iLink Bot 异步 HTTP 客户端。"""

    def __init__(self, bot_token: str = "", base_url: str = DEFAULT_BASE_URL):
        self.bot_token = bot_token
        self.base_url = base_url.rstrip("/")
        self._client: Optional[httpx.AsyncClient] = None

    async def start(self) -> None:
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(_GETUPDATES_TIMEOUT))

    async def stop(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    def _url(self, path: str) -> str:
        return f"{self.base_url}/{path}"

    async def _get(self, path: str, params: dict | None = None, *, timeout: float = _DEFAULT_TIMEOUT) -> Any:
        assert self._client is not None, "ILinkClient not started"
        resp = await self._client.get(self._url(path), params=params or {},
                                      headers=make_headers(self.bot_token), timeout=timeout)
        resp.raise_for_status()
        return resp.json()

    async def _post(self, path: str, body: dict, *, timeout: float = _DEFAULT_TIMEOUT) -> Any:
        assert self._client is not None, "ILinkClient not started"
        resp = await self._client.post(self._url(path), json=body,
                                       headers=make_headers(self.bot_token), timeout=timeout)
        resp.raise_for_status()
        return resp.json()

    # ── 登录 ──────────────────────────────────────────────────────────────────
    async def get_bot_qrcode(self) -> dict:
        """拉登录二维码。返回 `{qrcode, qrcode_img_content(base64 PNG)}`。bot_type=3 个人微信。"""
        return await self._get("ilink/bot/get_bot_qrcode", {"bot_type": 3})

    async def get_qrcode_status(self, qrcode: str) -> dict:
        """轮询扫码状态。status: waiting/scanned/confirmed/expired；confirmed 时带 `bot_token`/`baseurl`。"""
        return await self._get("ilink/bot/get_qrcode_status", {"qrcode": qrcode},
                               timeout=_QRCODE_STATUS_TIMEOUT)

    # ── 消息收发 ──────────────────────────────────────────────────────────────
    async def getupdates(self, cursor: str = "") -> dict:
        """long-poll 收消息（服务端最多挂 ~35s）。返回 `{ret, msgs[], get_updates_buf}`，buf 是下次游标。"""
        return await self._post("ilink/bot/getupdates",
                                {"get_updates_buf": cursor,
                                 "base_info": {"channel_version": CHANNEL_VERSION}},
                                timeout=_GETUPDATES_TIMEOUT)

    async def sendmessage(self, msg: dict) -> dict:
        """发任意结构消息。msg 必须含 to_user_id/message_type/message_state/context_token/item_list。"""
        return await self._post("ilink/bot/sendmessage",
                                {"msg": msg, "base_info": {"channel_version": CHANNEL_VERSION}})

    async def send_text(self, to_user_id: str, text: str, context_token: str) -> dict:
        """发纯文本。`context_token` 来自入站消息（iLink 必需，端到端会话凭证）。"""
        return await self.sendmessage({
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": str(uuid.uuid4()),
            "message_type": 2,    # 2 = BOT
            "message_state": 2,   # 2 = FINISH
            "context_token": context_token,
            "item_list": [{"type": 1, "text_item": {"text": text}}],
        })

    # ── 媒体（CDN 上传预签名 URL，由调用方拿到后 PUT 加密文件）────────────────
    async def get_upload_url(self, body: dict | None = None) -> dict:
        """拿 CDN 上传预签名 URL。响应含 `upload_full_url` / `upload_param` 字段（两者
        至少有一个，前者优先），调用方 PUT 加密文件后再用返回的 filekey 拼到
        sendmessage.item_list（type=2 图片 / type=4 文件）。

        body 字段（与 OpenClaw api/types.ts GetUploadUrlReq 一致）：
          - filekey: 16B hex（上传唯一标识）
          - aeskey: hex（喂给 CDN 用作加密 key 的 hex 形式）
          - media_type: 1=IMAGE / 2=VIDEO / 3=FILE / 4=VOICE
          - to_user_id: 收件用户 ID（必填，CDN 校验权限）
          - rawsize: 明文字节数
          - rawfilemd5: 明文 MD5 hex
          - filesize: 密文字节数（AES-128-ECB + PKCS7 加密后）
          - no_need_thumb: True 跳过缩略图（图片/视频可选，文件必 True）

        AES-128-ECB 加密 / CDN 域名 / 上传流程详见 `wechat_media_crypto.py`。
        """
        payload = dict(body or {})
        payload.setdefault("base_info", {"channel_version": CHANNEL_VERSION})
        return await self._post("ilink/bot/getuploadurl", payload)

    # ── typing 状态（2026-07-09 接入，参考 OpenClaw api/api.ts）────────────────
    async def get_config(self, ilink_user_id: str, context_token: str = "") -> dict:
        """拿该用户的 `typing_ticket`（base64 串，每用户独立、有效期 24h）。

        用于 `sendtyping` 调用凭证。没拿到时（ret≠0 / 异常）`typing_ticket` 字段为空，
        调用方按空 ticket 走"不发 typing"分支，不挡主流程。

        入参 context_token **建议传**（同一条 inbound 的），实测不带也能成功但官方
        SDK 这么传，仿 OpenClaw `monitor.ts:179`。复用同一个 inbound 的 token 也避免
        上下游 token 不一致。
        """
        return await self._post("ilink/bot/getconfig",
                                {"ilink_user_id": ilink_user_id,
                                 "context_token": context_token,
                                 "base_info": {"channel_version": CHANNEL_VERSION}})

    async def send_typing(self, ilink_user_id: str, typing_ticket: str, status: int) -> dict:
        """发 typing 状态。status: `TYPING_ON`(1)=显示 / `TYPING_OFF`(2)=取消。

        typing 状态本身有超时（约 10s 不发就自动消失），所以 OpenClaw 在 keepalive_loop
        里每 5s 重发一次。失败静默 log，不挡主流程——typing 是锦上添花。
        """
        if not typing_ticket:
            # 没 ticket 时直接短路（与 OpenClaw createTypingCallbacks 的退化分支一致）
            return {"ret": 0, "errmsg": "no typing_ticket, skipped"}
        return await self._post("ilink/bot/sendtyping",
                                {"ilink_user_id": ilink_user_id,
                                 "typing_ticket": typing_ticket,
                                 "status": status,
                                 "base_info": {"channel_version": CHANNEL_VERSION}})

    # ── 通道通知（网关启停时告知上游，避免长连接悬挂）─────────────────────────
    async def notify_start(self) -> dict:
        """通道（网关）启动通知。gateway 拉起 wechat 子进程后调一次。"""
        return await self._post("ilink/bot/msg/notifystart",
                                {"base_info": {"channel_version": CHANNEL_VERSION}})

    async def notify_stop(self) -> dict:
        """通道停止通知。gateway 收 SIGTERM 后优雅退出前调一次（独立 timeout，
        不受主进程 abort 影响——参考 OpenClaw api/api.ts notifyStop 注释）。"""
        return await self._post("ilink/bot/msg/notifystop",
                                {"base_info": {"channel_version": CHANNEL_VERSION}})