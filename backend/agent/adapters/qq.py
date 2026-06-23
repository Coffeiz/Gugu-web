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
        if not text:
            return
        openid = message.author.user_openid if message.author else None
        payload = {
            "platform": "qqbot",
            "channel_id": self._channel_id,
            "owner_user_id": self._owner,      # BYO：bot 归属即用户，worker 直接用
            "platform_user_id": openid,
            "message_id": message.id,
            "chat_type": "c2c",
            "text": text,
        }
        print(f"[qq:{self._channel_id}] 收到 {openid}: {text!r}", flush=True)
        try:
            await R.produce(STREAM, payload)
        except Exception as e:
            print(f"[qq] 入队失败: {type(e).__name__}: {e}", flush=True)


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


async def send_c2c(openid: str, text: str, msg_id: str | None = None,
                   channel_id: str | None = None) -> bool:
    """给指定用户发 C2C 被动回复（带原 msg_id）。token 过期等异常时重建一次再试。"""
    for attempt in (1, 2):
        try:
            api = await _api_for(channel_id)
            await api.post_c2c_message(openid=openid, msg_type=0, content=text, msg_id=msg_id)
            return True
        except Exception as e:
            print(f"[qq] 发送失败(第{attempt}次): {type(e).__name__}: {e}", flush=True)
            _apis.pop(channel_id, None)   # 丢弃缓存，下次重新 login
    return False


if __name__ == "__main__":
    serve()
