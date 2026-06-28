"""微信 iLink 扫码自动连接（个人微信，官方 iLink Bot API，无需企业资质）。

机制（比 QQ 简单——iLink 自己就是官方 bot 服务，不经第三方门户、无需 AES）：
  1. POST  /me/wechat/connect          → 调 iLink get_bot_qrcode 出码（qrcode + PNG 图）
  2. 前端把 PNG（base64）直接渲染成二维码，用户手机微信扫
  3. GET   /me/wechat/connect/{task}   → 轮询 iLink get_qrcode_status(qrcode)
  4. status==confirmed 时拿 bot_token + baseurl → 写该用户的 UserBot(platform=wechat)
     （bot_token 存 app_secret、baseurl 存 app_id，复用现有字段）→ 发 im:supervisor:reload

task_id 用 uuid、真正的 qrcode 串存 Redis（按 task_id，带 uid 防跨用户），避免 qrcode 含
特殊字符进 URL path 出问题，也不把它下发前端。
"""
from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import redis as R
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User, UserBot
from agent.adapters.wechat_client import ILinkClient

router = APIRouter(prefix="/me/wechat/connect", tags=["wechat-connect"])

TASK_TTL = 600  # 10 分钟


def _redis_key(task_id: str) -> str:
    return f"wechatconnect:{task_id}"


@router.post("")
async def start(current_user: User = Depends(get_current_user)):
    """拉取 iLink 登录二维码，返回 base64 PNG 供前端渲染。"""
    client = ILinkClient()
    await client.start()
    try:
        data = await client.get_bot_qrcode()
    except Exception as e:
        raise HTTPException(502, f"获取微信二维码失败：{e}")
    finally:
        await client.stop()

    qrcode = data.get("qrcode", "")
    # ⚠️ iLink 的 qrcode_img_content 其实是「扫码 URL」（liteapp.weixin.qq.com/q/...），不是图片 base64。
    # 前端用 QRCode 把它渲染成二维码即可（和飞书/QQ 同一套），别当 data:image 用。
    scan_url = data.get("qrcode_img_content", "")
    if not qrcode or not scan_url:
        raise HTTPException(502, "微信未返回二维码")

    task_id = uuid.uuid4().hex
    await R.get_redis().set(
        _redis_key(task_id),
        json.dumps({"uid": str(current_user.id), "qrcode": qrcode}),
        ex=TASK_TTL,
    )
    return {"task_id": task_id, "scan_url": scan_url}


@router.get("/{task_id}")
async def poll(
    task_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """轮询扫码状态；confirmed 则写入该用户的 UserBot（platform=wechat）。"""
    raw = await R.get_redis().get(_redis_key(task_id))
    if not raw:
        return {"status": "expired"}
    meta = json.loads(raw)
    if meta.get("uid") != str(current_user.id):
        raise HTTPException(403, "任务不属于当前用户")

    client = ILinkClient()
    await client.start()
    try:
        data = await client.get_qrcode_status(meta["qrcode"])
    except Exception as e:
        raise HTTPException(502, f"轮询微信扫码失败：{e}")
    finally:
        await client.stop()

    status = data.get("status", "")
    if status == "expired":
        await R.get_redis().delete(_redis_key(task_id))
        return {"status": "expired"}
    if status != "confirmed":
        return {"status": "waiting"}   # waiting / scanned

    # 确认：拿 bot_token + baseurl，写 UserBot
    bot_token = data.get("bot_token", "")
    base_url = data.get("baseurl", "")
    if not bot_token:
        return {"status": "fail", "reason": "未拿到 bot_token"}

    # upsert：一个用户一个微信 bot（按 platform=wechat 去重）
    existing = (await db.execute(
        select(UserBot).where(UserBot.user_id == current_user.id,
                              UserBot.platform == "wechat")
    )).scalars().first()
    if existing:
        existing.app_secret = bot_token   # bot_token 复用 app_secret
        existing.app_id = base_url        # base_url 复用 app_id
        existing.enabled = True
        bot = existing
    else:
        bot = UserBot(user_id=current_user.id, platform="wechat", name="我的微信",
                      app_id=base_url, app_secret=bot_token, sandbox=False, enabled=True)
        db.add(bot)
    await db.commit()
    await db.refresh(bot)
    await R.get_redis().delete(_redis_key(task_id))

    try:
        await R.get_redis().publish("im:supervisor:reload", "1")
    except Exception:
        pass

    return {"status": "success", "bot": {"id": bot.id, "name": bot.name}}
