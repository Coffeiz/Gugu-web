"""飞书 OAuth 扫码绑定（方案 A 轻绑定）。

流程：用户在咕咕设置页点「绑定飞书」→ 拿授权 URL（渲染成二维码）→ 飞书扫码授权
→ 回调用 code 换 user_access_token 取 open_id → 写 PlatformBinding(feishu, open_id)→user_id
→ 之后用户私聊咕咕 bot，网关按 open_id 查到 user_id，按其数据回。

state 用 JWT 签（带 user_id + channel_id + 短过期），回调时校验，防伪造/跨用户。
只取 open_id 认人，不存 user_access_token（聊天场景够用）。
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from jose import jwt, JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import active_im_bots, get_settings
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import PlatformBinding, User

router = APIRouter(prefix="/feishu", tags=["feishu-bind"])

_AUTHORIZE = "https://open.feishu.cn/open-apis/authen/v1/authorize"
_STATE_TTL = 600  # 10 分钟


def _sign_state(user_id: str, channel_id: str) -> str:
    s = get_settings()
    payload = {"uid": str(user_id), "cid": channel_id, "typ": "fsbind", "exp": int(time.time()) + _STATE_TTL}
    return jwt.encode(payload, s.secret_key, algorithm="HS256")


def _verify_state(state: str) -> tuple[str, str]:
    s = get_settings()
    try:
        p = jwt.decode(state, s.secret_key, algorithms=["HS256"])
    except JWTError:
        raise HTTPException(400, "state 无效或已过期")
    if p.get("typ") != "fsbind":
        raise HTTPException(400, "state 类型错误")
    return p["uid"], p.get("cid", "")


def _first_feishu_channel() -> dict | None:
    bots = active_im_bots("feishu")
    return bots[0] if bots else None


@router.get("/bind/url")
async def bind_url(current_user: User = Depends(get_current_user)):
    """返回飞书授权 URL（前端渲染成二维码）。"""
    cfg = get_settings().feishu
    ch = _first_feishu_channel()
    if not ch:
        raise HTTPException(400, "尚未配置启用的飞书频道（Admin → Agent 配置 → 频道）")
    if not cfg.redirect_uri:
        raise HTTPException(400, "尚未配置飞书回调地址 redirect_uri（FEISHU__REDIRECT_URI 或 Admin）")
    state = _sign_state(current_user.id, ch["id"])
    url = (
        f"{_AUTHORIZE}?app_id={ch['app_id']}"
        f"&redirect_uri={quote(cfg.redirect_uri, safe='')}"
        f"&state={state}"
    )
    return {"url": url, "channel_name": ch.get("name", "飞书")}


@router.get("/bind/callback", response_class=HTMLResponse)
async def bind_callback(
    code: str = Query(...),
    state: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """飞书授权后回调：code 换 open_id → 写绑定。返回一个提示页面（飞书里打开）。"""
    user_id, channel_id = _verify_state(state)
    ch = next((b for b in active_im_bots("feishu") if b["id"] == channel_id), None) or _first_feishu_channel()
    if not ch:
        return _page("绑定失败", "飞书频道配置丢失")

    # code 换 token 取 open_id（lark 同步 SDK，丢线程跑）
    try:
        open_id, name = await asyncio.to_thread(_exchange, ch["app_id"], ch["app_secret"], code)
    except Exception as e:
        return _page("绑定失败", f"换取身份失败：{str(e)[:80]}")
    if not open_id:
        return _page("绑定失败", "未取到飞书身份")

    # upsert 绑定（一个 open_id 对一个咕咕账号）
    existing = (await db.execute(
        select(PlatformBinding).where(
            PlatformBinding.platform == "feishu",
            PlatformBinding.platform_user_id == open_id,
        )
    )).scalars().first()
    if existing:
        existing.user_id = user_id
        existing.channel_id = channel_id
        existing.display_name = name or existing.display_name
    else:
        db.add(PlatformBinding(
            user_id=user_id, platform="feishu", platform_user_id=open_id,
            channel_id=channel_id, display_name=name or "",
        ))
    await db.commit()
    return _page("绑定成功 ✓", f"飞书账号「{name or open_id}」已绑定到你的咕咕，可以关闭本页，回飞书找咕咕聊天啦。")


@router.get("/bind/status")
async def bind_status(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    b = (await db.execute(
        select(PlatformBinding).where(
            PlatformBinding.user_id == current_user.id,
            PlatformBinding.platform == "feishu",
        )
    )).scalars().first()
    if not b:
        return {"bound": False}
    return {"bound": True, "display_name": b.display_name, "open_id": b.platform_user_id}


@router.delete("/bind", status_code=204)
async def unbind(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(
        select(PlatformBinding).where(
            PlatformBinding.user_id == current_user.id,
            PlatformBinding.platform == "feishu",
        )
    )).scalars().all()
    for r in rows:
        await db.delete(r)
    await db.commit()


# ── 内部 ──
def _exchange(app_id: str, app_secret: str, code: str) -> tuple[str, str]:
    """用 code 换 user_access_token，取 open_id + name（lark 同步 SDK）。"""
    import lark_oapi as lark
    from lark_oapi.api.authen.v1 import (
        CreateAccessTokenRequest, CreateAccessTokenRequestBody,
    )
    client = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    req = (
        CreateAccessTokenRequest.builder()
        .request_body(
            CreateAccessTokenRequestBody.builder()
            .grant_type("authorization_code").code(code).build()
        ).build()
    )
    resp = client.authen.v1.access_token.create(req)
    if not resp.success() or not resp.data:
        raise RuntimeError(f"code={getattr(resp,'code',None)} msg={getattr(resp,'msg',None)}")
    return resp.data.open_id, (resp.data.name or "")


def _page(title: str, msg: str) -> HTMLResponse:
    html = f"""<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>{title}</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;background:#f5f6fa">
<div style="text-align:center;padding:32px 28px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:340px">
<div style="font-size:18px;font-weight:600;color:#1e2028;margin-bottom:10px">{title}</div>
<div style="font-size:14px;color:#6b7280;line-height:1.6">{msg}</div>
</div></body></html>"""
    return HTMLResponse(html)
