"""飞书扫码自动创建 app + 连接（复刻 QwenPaw 的 OAuth 2.0 设备授权流，实测无需合作方资质）。

机制（accounts.feishu.cn 的 app 注册 device flow，全程无鉴权）：
  1. POST /oauth/v1/app/registration action=init  → supported_auth_methods（含 client_secret）
  2. POST … action=begin (archetype=PersonalAgent, auth_method=client_secret)
       → device_code + verification_uri_complete（手机扫码授权页）
  3. 前端把 verification_uri_complete?source=Gugu 渲染成二维码
  4. 用户手机飞书扫码 → 授权创建一个 PersonalAgent 应用
  5. 轮询 POST … action=poll {device_code} → 成功返回 client_id + client_secret（即 App ID/Secret）
  6. 写该用户的 user_bots（platform=feishu）

device_code 只存服务端 Redis（按 poll_id），不下发前端。BYO 模型，bot 即归属，无需绑定。
"""
from __future__ import annotations

import json
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import redis as R
from app.core.security import get_current_user
from app.core.tz import now_utc
from app.db.session import get_db
from app.models import User, UserBot

router = APIRouter(prefix="/me/feishu/connect", tags=["feishu-connect"])

# 国内飞书；国际版 Lark 为 https://accounts.larksuite.com（如需再加 domain 参数）
ACCOUNTS = "https://accounts.feishu.cn"
REG_ENDPOINT = ACCOUNTS + "/oauth/v1/app/registration"
SOURCE = "Gugu"
TASK_TTL = 3600  # device flow expires_in
_FORM = {"Content-Type": "application/x-www-form-urlencoded"}


def _rk(poll_id: str) -> str:
    return f"feishuconnect:{poll_id}"


async def _post(action: str, raise_on_error: bool = True, **fields):
    async with httpx.AsyncClient(timeout=15) as c:
        resp = await c.post(REG_ENDPOINT, content=urlencode({"action": action, **fields}), headers=_FORM)
        # device flow 轮询等待时按 RFC 8628 返回 400 + {"error":"authorization_pending"}，poll 不能抛
        if raise_on_error:
            resp.raise_for_status()
        return resp.json()


@router.post("")
async def start(current_user: User = Depends(get_current_user)):
    """init + begin，返回扫码 URL（前端渲染二维码）。"""
    try:
        init = await _post("init")
        if "client_secret" not in (init.get("supported_auth_methods") or []):
            raise HTTPException(502, "飞书不支持 client_secret 注册方式")
        begin = await _post(
            "begin", archetype="PersonalAgent",
            auth_method="client_secret", request_user_info="open_id",
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"创建飞书连接任务失败：{e}")

    device_code = begin.get("device_code")
    verify_uri = begin.get("verification_uri_complete")
    if not device_code or not verify_uri:
        raise HTTPException(502, "飞书未返回 device_code / 扫码地址")

    poll_id = secrets.token_urlsafe(16)
    await R.get_redis().set(
        _rk(poll_id),
        json.dumps({"uid": str(current_user.id), "device_code": device_code}),
        ex=TASK_TTL,
    )
    sep = "&" if "?" in verify_uri else "?"
    scan_url = f"{verify_uri}{sep}source={SOURCE}"
    return {"poll_id": poll_id, "scan_url": scan_url}


@router.get("/{poll_id}")
async def poll(
    poll_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """轮询授权结果；完成则写入该用户的 UserBot。"""
    raw = await R.get_redis().get(_rk(poll_id))
    if not raw:
        return {"status": "expired"}
    meta = json.loads(raw)
    if meta.get("uid") != str(current_user.id):
        raise HTTPException(403, "任务不属于当前用户")

    try:
        data = await _post("poll", raise_on_error=False, device_code=meta["device_code"])
    except Exception as e:
        raise HTTPException(502, f"轮询失败：{e}")

    client_id = data.get("client_id")
    client_secret = data.get("client_secret")
    if client_id and client_secret:
        # upsert：同一用户同一 app_id 不重复建
        existing = (await db.execute(
            select(UserBot).where(UserBot.user_id == current_user.id,
                                  UserBot.platform == "feishu", UserBot.app_id == client_id)
        )).scalars().first()
        if existing:
            existing.app_secret = client_secret
            existing.enabled = True
            bot = existing
        else:
            bot = UserBot(user_id=current_user.id, platform="feishu",
                          name="我的飞书机器人", app_id=client_id, app_secret=client_secret,
                          sandbox=False, enabled=True)
            db.add(bot)
        await db.commit()
        await db.refresh(bot)
        # 连接时存 owner 可触达地址（open_id）→ 选了飞书无需先聊天即可主动投递
        oid = (data.get("user_info") or {}).get("open_id") or data.get("open_id")
        if oid:
            bot.owner_platform_user_id = str(oid)
            bot.owner_bound_at = now_utc()
            await db.commit()
            try:
                from app import scheduled_tasks as ST
                await ST.save_imreach(current_user.id, "feishu", str(bot.id), None, oid)
            except Exception:
                pass
        await R.get_redis().delete(_rk(poll_id))
        try:
            await R.get_redis().publish("im:supervisor:reload", "1")
        except Exception:
            pass
        return {"status": "success", "bot": {"id": bot.id, "name": bot.name, "app_id": bot.app_id}}

    err = data.get("error", "")
    if err in ("expired_token", "invalid_grant"):
        await R.get_redis().delete(_rk(poll_id))
        return {"status": "expired"}
    if err == "access_denied":
        await R.get_redis().delete(_rk(poll_id))
        return {"status": "fail", "reason": "用户拒绝了授权"}
    # authorization_pending / slow_down / 其它 → 继续等
    return {"status": "waiting"}
