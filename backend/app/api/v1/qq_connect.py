"""QQ 扫码自动连接（复刻 QwenPaw/OpenClaw 的 q.qq.com bind_task 流程）。

机制（全程无鉴权，安全靠 AES-GCM——secret 用本地生成的 key 加密回传，只有我们能解）：
  1. POST q.qq.com/lite/create_bind_task {"key": <aes_key>} → task_id
  2. 前端把 connect.html?task_id=..&_wv=2&source=Gugu 渲染成二维码
  3. 用户手机 QQ 扫码 → QQ App 内选一个 bot 授权
  4. 轮询 q.qq.com/lite/poll_bind_result {"task_id"} → status==2 时拿 bot_appid + 加密的 secret
  5. 用 aes_key 解出 AppSecret → 直接写成该用户的 UserBot（自动填 key，无需手动复制）

aes_key 只存服务端（Redis，按 task_id），不下发前端，避免泄漏。
"""
from __future__ import annotations

import base64
import json
import os

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import redis as R
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User, UserBot

router = APIRouter(prefix="/me/qq/connect", tags=["qq-connect"])

PORTAL_HOST = os.getenv("QQ_PORTAL_HOST", "q.qq.com")
CREATE_URL = f"https://{PORTAL_HOST}/lite/create_bind_task"
POLL_URL = f"https://{PORTAL_HOST}/lite/poll_bind_result"
FRONTEND = f"https://{PORTAL_HOST}/qqbot/openclaw/connect.html"
SOURCE = "Gugu"
TASK_TTL = 600  # 10 分钟


def _gen_key() -> str:
    return base64.b64encode(os.urandom(32)).decode()


def _decrypt_secret(encrypted_b64: str, key_b64: str) -> str:
    """AES-256-GCM 解密：raw = iv(12) + ciphertext+tag。"""
    key = base64.b64decode(key_b64)
    raw = base64.b64decode(encrypted_b64)
    if len(raw) < 28:
        raise ValueError("ciphertext too short")
    return AESGCM(key).decrypt(raw[:12], raw[12:], None).decode("utf-8")


def _redis_key(task_id: str) -> str:
    return f"qqconnect:{task_id}"


@router.post("")
async def start(current_user: User = Depends(get_current_user)):
    """创建 bind task，返回扫码 URL（前端渲染二维码）。"""
    aes_key = _gen_key()
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            resp = await c.post(CREATE_URL, json={"key": aes_key},
                                headers={"Content-Type": "application/json"})
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        raise HTTPException(502, f"创建 QQ 连接任务失败：{e}")
    if data.get("retcode") != 0:
        raise HTTPException(502, f"QQ 返回错误：{data.get('msg', '')}")
    task_id = (data.get("data") or {}).get("task_id")
    if not task_id:
        raise HTTPException(502, "QQ 未返回 task_id")

    # aes_key 只存服务端
    await R.get_redis().set(
        _redis_key(task_id),
        json.dumps({"uid": str(current_user.id), "key": aes_key}),
        ex=TASK_TTL,
    )
    scan_url = f"{FRONTEND}?task_id={task_id}&_wv=2&source={SOURCE}"
    return {"task_id": task_id, "scan_url": scan_url}


@router.get("/{task_id}")
async def poll(
    task_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """轮询授权结果；完成则解密并写入该用户的 UserBot。"""
    raw = await R.get_redis().get(_redis_key(task_id))
    if not raw:
        return {"status": "expired"}
    meta = json.loads(raw)
    if meta.get("uid") != str(current_user.id):
        raise HTTPException(403, "任务不属于当前用户")

    try:
        async with httpx.AsyncClient(timeout=10) as c:
            resp = await c.post(POLL_URL, json={"task_id": task_id},
                                headers={"Content-Type": "application/json"})
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        raise HTTPException(502, f"轮询失败：{e}")

    if data.get("retcode") != 0:
        return {"status": "fail", "reason": data.get("msg", "unknown")}

    rd = data.get("data") or {}
    status = rd.get("status", -1)
    if status == 3:
        await R.get_redis().delete(_redis_key(task_id))
        return {"status": "expired"}
    if status != 2:
        return {"status": "waiting"}

    # 完成：解密 secret，写 UserBot
    app_id = str(rd.get("bot_appid") or "")
    enc = rd.get("bot_encrypt_secret") or ""
    if not app_id or not enc:
        return {"status": "fail", "reason": "缺少 app_id 或 secret"}
    try:
        secret = _decrypt_secret(enc, meta["key"])
    except Exception:
        return {"status": "fail", "reason": "secret 解密失败"}

    # upsert：同一用户同一 app_id 不重复建
    existing = (await db.execute(
        select(UserBot).where(UserBot.user_id == current_user.id,
                              UserBot.platform == "qq", UserBot.app_id == app_id)
    )).scalars().first()
    if existing:
        existing.app_secret = secret
        existing.enabled = True
        bot = existing
    else:
        existing_platform_bot = (await db.execute(
            select(UserBot).where(
                UserBot.user_id == current_user.id,
                UserBot.platform == "qq",
            )
        )).scalars().first()
        if existing_platform_bot:
            await R.get_redis().delete(_redis_key(task_id))
            return {"status": "fail", "reason": "每个咕咕账号只能绑定一个 QQ 机器人"}
        bot = UserBot(user_id=current_user.id, platform="qq",
                      name="我的 QQ 机器人", app_id=app_id, app_secret=secret,
                      sandbox=False, enabled=True)
        db.add(bot)
    await db.commit()
    await db.refresh(bot)
    await R.get_redis().delete(_redis_key(task_id))
    from app.core import events
    await events.bump_context_revision(current_user.id, "im_channels")

    # 通知 gateway 立即重扫（失败也无所谓，下轮会同步）
    try:
        await R.get_redis().publish("im:gateway:reload", "1")
    except Exception:
        pass

    return {"status": "success", "bot": {"id": bot.id, "name": bot.name, "app_id": bot.app_id}}
