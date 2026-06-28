"""微信 iLink Bot API 的异步 HTTP 客户端（文本收发 MVP）。

iLink 是微信官方给**个人微信号**的 bot 接入（`https://ilinkai.weixin.qq.com`，
扫码授权拿 bot_token，无需企业资质、非逆向、官方 HTTP API）。协议参考微信官方
iLink Bot HTTP API（weixin.qq.com/cgi-bin/readtemplate?t=ilink/chatbot）。

- 登录：`get_bot_qrcode` 出码 → 轮询 `get_qrcode_status` → 拿 `bot_token`。
- 收：`getupdates` long-poll（服务端最多挂 ~35s）。
- 发：`sendmessage` —— **必须带入站消息给的 `context_token`**（iLink 端到端会话凭证）。
- 媒体（图片/语音/文件，AES-128-ECB）暂未实现，先文本 MVP。
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

    # ── 消息 ──────────────────────────────────────────────────────────────────
    async def getupdates(self, cursor: str = "") -> dict:
        """long-poll 收消息（服务端最多挂 ~35s）。返回 `{ret, msgs[], get_updates_buf}`，buf 是下次游标。"""
        return await self._post("ilink/bot/getupdates",
                                {"get_updates_buf": cursor,
                                 "base_info": {"channel_version": CHANNEL_VERSION}},
                                timeout=_GETUPDATES_TIMEOUT)

    async def sendmessage(self, msg: dict) -> dict:
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
