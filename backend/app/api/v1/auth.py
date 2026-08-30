from datetime import datetime, timedelta
from pathlib import Path
from uuid import UUID
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File as FastAPIFile
from fastapi.responses import Response
from sqlalchemy import and_, select, func
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.core.ratelimit import rate_limit
from app.core.redis import get_redis
from app.core.security import hash_password, verify_password, create_user_token, get_current_user
from app.core.tz import now_utc, iso_utc
from app.db.session import get_db
from app.models import User, AgentUsage, FrontendEvent
from app.schemas import UserRegister, UserLogin, UserResponse, TokenResponse, UpdateProfile, ForgotPassword, ResetPassword, DeleteAccount
from app.services import email as email_svc

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=TokenResponse, status_code=201)
async def register(body: UserRegister, request: Request, db: AsyncSession = Depends(get_db)):
    await rate_limit(request, "register", 20, 3600)   # 同 IP 每小时最多 20 次注册尝试
    existing = await db.execute(
        select(User).where(
            (User.username == body.username) | (User.email == body.email)
        )
    )
    if existing.scalars().first():
        raise HTTPException(400, "用户名或邮箱已被注册")

    user = User(
        username=body.username,
        email=body.email,
        hashed_password=hash_password(body.password),
        display_name=body.username,
    )
    db.add(user)
    await db.flush()

    await db.commit()
    await db.refresh(user)

    # 新手引导播种（独立子系统，best-effort：内部已吞异常，不影响注册）
    from onboarding.seed import seed_for_user
    await seed_for_user(db, user, locale=body.locale)

    return TokenResponse(
        access_token=create_user_token(user.id),
        user=UserResponse.from_user(user),
    )


@router.post("/login", response_model=TokenResponse)
async def login(body: UserLogin, request: Request, db: AsyncSession = Depends(get_db)):
    await rate_limit(request, "login", 10, 300, extra=body.username)   # 同 IP+用户名 5 分钟最多 10 次
    # 登录标识既可以是用户名也可以是邮箱——两个字段都有唯一约束，不会互相碰撞匹配到别人。
    result = await db.execute(
        select(User).where((User.username == body.username) | (User.email == body.username))
    )
    user = result.scalars().first()

    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(401, "用户名或密码错误")
    if not user.is_active:
        raise HTTPException(403, "账号已停用，请联系管理员")

    # 登录既是网页端一次明确的活跃行为，也要留下可按天回溯的事件。last_active_at 供滚动
    # 窗口统计兜底，FrontendEvent 则让历史 DAU 不会因同一用户后来再次活跃而丢掉旧日期。
    user.last_active_at = now_utc()
    db.add(FrontendEvent(user_id=user.id, event="web_login"))
    await db.commit()

    return TokenResponse(
        access_token=create_user_token(user.id),
        user=UserResponse.from_user(user),
    )


# ── 密码找回 ────────────────────────────────────────────────────────────────
_RESET_TOKEN_TTL = 30 * 60   # 重置链接有效期 30 分钟
_RESET_COOLDOWN  = 60        # 同一邮箱 60s 内只发一封，防刷
_RESET_GENERIC   = {"ok": True, "message": "若该邮箱已注册，重置链接已发送，请查收邮箱（含垃圾箱）。"}


@router.post("/forgot-password")
async def forgot_password(body: ForgotPassword, request: Request, db: AsyncSession = Depends(get_db)):
    """申请重置：生成一次性 token 存 Redis，发邮件给注册邮箱。

    **无论邮箱是否注册都返回同一句**——避免通过接口枚举哪些邮箱已注册。"""
    await rate_limit(request, "forgot", 5, 3600)   # 同 IP 每小时最多 5 次找回请求
    email_in = (body.email or "").strip().lower()
    if not email_in or "@" not in email_in:
        return _RESET_GENERIC
    r = get_redis()
    cd_key = f"pwdreset:cd:{email_in}"
    if await r.get(cd_key):        # 冷却中，静默返回（不重复发信）
        return _RESET_GENERIC
    user = (await db.execute(
        select(User).where(func.lower(User.email) == email_in)
    )).scalars().first()
    if not user:
        return _RESET_GENERIC

    token = secrets.token_urlsafe(32)
    await r.set(f"pwdreset:tok:{token}", str(user.id), ex=_RESET_TOKEN_TTL)
    await r.set(cd_key, "1", ex=_RESET_COOLDOWN)

    # 重置链接基址：用服务端自身 base_url（经 nginx 固定为真实域名），**不信任可被任意伪造的 Origin 头**
    # ——否则攻击者伪造 Origin 即可把受害者邮件里的重置链接域名换成钓鱼站。
    origin = str(request.base_url).rstrip("/")
    link = f"{origin}/reset-password?token={token}"
    # 发信 best-effort：smtplib 是同步的，丢线程池避免阻塞事件循环；失败不暴露给前端
    try:
        await run_in_threadpool(
            email_svc.send_reset_email,
            to_addr=user.email, username=user.display_name or user.username, link=link,
        )
    except Exception:
        pass
    return _RESET_GENERIC


@router.post("/reset-password")
async def reset_password(body: ResetPassword, db: AsyncSession = Depends(get_db)):
    """凭一次性 token 设新密码：校验 token + 密码长度 → 改密 → 删 token（一次性）。"""
    token = (body.token or "").strip()
    pw = body.new_password or ""
    if len(pw) < 8:
        raise HTTPException(400, "密码至少 8 位")
    if not token:
        raise HTTPException(400, "链接无效")
    r = get_redis()
    uid = await r.get(f"pwdreset:tok:{token}")
    if not uid:
        raise HTTPException(400, "链接已失效或已被使用，请重新申请")
    user = await db.get(User, UUID(uid))
    if not user:
        raise HTTPException(400, "账号不存在")
    user.hashed_password = hash_password(pw)
    await db.commit()
    await r.delete(f"pwdreset:tok:{token}")   # 一次性：用完即焚
    return {"ok": True}


@router.get("/me", response_model=UserResponse)
async def me(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    now = now_utc()
    if current_user.last_active_at is None or (now - current_user.last_active_at) >= timedelta(hours=1):
        current_user.last_active_at = now
        await db.commit()
    from app.models import UserBot
    from app.scheduled_tasks import get_imreach
    from sqlalchemy import select as _select
    im_channels = []
    feishu_reach = await get_imreach(current_user.id, "feishu")
    if feishu_reach:
        im_channels.append("feishu")
    qq_bot = await db.scalar(_select(UserBot).where(
        UserBot.user_id == current_user.id,
        UserBot.platform == "qq",
        UserBot.enabled == True,
    ))
    if qq_bot:
        im_channels.append("qq")
    wechat_reach = await get_imreach(current_user.id, "wechat")
    if wechat_reach:
        im_channels.append("wechat")
    current_user._im_channels = im_channels
    return UserResponse.from_user(current_user)


@router.patch("/profile", response_model=UserResponse)
async def update_profile(
    body: UpdateProfile,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    timezone_changed = False
    if body.display_name is not None:
        current_user.display_name = body.display_name.strip() or None

    if body.timezone is not None:
        tz = body.timezone.strip()
        timezone_changed = tz != (current_user.timezone or "")
        if not tz:
            current_user.timezone = None
        else:
            from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
            try:
                ZoneInfo(tz)   # 只接受合法 IANA 名，非法直接拒（别静默存脏值）
            except (ZoneInfoNotFoundError, ValueError):
                raise HTTPException(400, "无效的时区")
            current_user.timezone = tz

    if body.new_password:
        if not body.current_password:
            raise HTTPException(400, "请输入当前密码")
        if not verify_password(body.current_password, current_user.hashed_password):
            raise HTTPException(400, "当前密码错误")
        current_user.hashed_password = hash_password(body.new_password)

    await db.commit()
    if timezone_changed:
        from app.core import events
        await events.bump_context_revision(current_user.id, "timezone")
    await db.refresh(current_user)
    return UserResponse.from_user(current_user)


@router.delete("/me", status_code=204)
async def delete_my_account(
    body: DeleteAccount,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """用户自助注销：本人验证密码后永久删除账号 + 全部数据，不可恢复。
    实际删除逻辑复用 app/services/account_deletion.delete_account（与 admin 代删同一份，避免两处漂移）。
    要密码而不只信前端弹窗确认——JWT 会话可能被盗用/误触，这种不可逆操作值得多一道校验
    （跟改密码要输入当前密码是同一个安全标准）。"""
    if not verify_password(body.password, current_user.hashed_password):
        raise HTTPException(400, "密码错误")
    from app.services.account_deletion import delete_account
    await delete_account(db, current_user)


_ALLOWED_AVATAR_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
_AVATAR_MAX_BYTES = 5 * 1024 * 1024  # 5 MB


@router.post("/avatar", response_model=UserResponse)
async def upload_avatar(
    file: UploadFile = FastAPIFile(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if file.content_type not in _ALLOWED_AVATAR_TYPES:
        raise HTTPException(400, "仅支持 JPEG/PNG/WebP/GIF 格式")
    data = await file.read()
    if len(data) > _AVATAR_MAX_BYTES:
        raise HTTPException(400, "头像文件不能超过 5MB")

    # 存盘后缀从已校验的 content_type 推导，不用客户端传的 filename——粘贴/剪贴板图片
    # 常常没有扩展名（如 "blob"），若从 filename 推导会存出垃圾后缀，导致 get_avatar()
    # 按后缀猜 MIME 时全部兜底成 image/jpeg，显示异常。
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}[file.content_type]
    settings = get_settings()
    avatar_dir = Path(settings.storage.local_path) / "avatars"
    avatar_dir.mkdir(parents=True, exist_ok=True)
    avatar_path = avatar_dir / f"{current_user.id}.{ext}"
    # 换后缀上传时清掉该用户旧头像文件（如原来是 .png、这次存 .webp），避免残留占空间
    for old in avatar_dir.glob(f"{current_user.id}.*"):
        if old != avatar_path:
            old.unlink(missing_ok=True)
    avatar_path.write_bytes(data)

    current_user.avatar = f"avatars/{current_user.id}.{ext}"
    db.add(current_user)
    await db.commit()
    await db.refresh(current_user)
    return UserResponse.from_user(current_user)


@router.get("/quota")
async def get_quota(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    settings = get_settings()
    now = now_utc()

    async def _used(since: datetime) -> int:
        r = await db.execute(
            select(func.sum(AgentUsage.tokens_in + AgentUsage.tokens_out))
            .where(and_(AgentUsage.user_id == current_user.id, AgentUsage.created_at >= since, AgentUsage.is_byok.is_(False)))
        )
        return r.scalar() or 0

    # 6h 用户窗口 + 周窗口：与 quota.is_exhausted（硬拦）共用同一套口径。
    from agent import quota as _quota
    stored_window_start = current_user.quota_window_started_at
    window_active = stored_window_start is not None and now < stored_window_start + timedelta(hours=6)
    window_start = stored_window_start if window_active else None
    reset_6h_at = window_start + timedelta(hours=6) if window_start else None
    used_6h = await _used(window_start) if window_start else 0

    week_start = _quota._week_start(now)
    used_weekly = await _used(week_start)

    has_byok = await _quota.has_active_byok_llm(db, current_user.id, settings)
    limit_6h = None if has_byok else (current_user.token_limit_6h or settings.quota.default_token_limit_6h)
    limit_weekly = None if has_byok else (current_user.token_limit_weekly or settings.quota.default_token_limit_weekly)

    return {
        "used_6h":      used_6h,
        "limit_6h":     limit_6h,
        "reset_6h_at":  iso_utc(reset_6h_at) if reset_6h_at else None,   # 当前窗口结束时刻
        "used_weekly":  used_weekly,
        "limit_weekly": limit_weekly,
    }


@router.get("/avatar/{user_id}")
async def get_avatar(user_id: UUID, db: AsyncSession = Depends(get_db)):
    user = await db.get(User, user_id)
    if not user or not user.avatar:
        raise HTTPException(404, "头像不存在")
    settings = get_settings()
    avatar_path = Path(settings.storage.local_path) / user.avatar
    if not avatar_path.exists():
        raise HTTPException(404, "头像文件不存在")
    ext = user.avatar.rsplit(".", 1)[-1].lower()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
            "webp": "image/webp", "gif": "image/gif"}.get(ext, "image/jpeg")
    return Response(content=avatar_path.read_bytes(), media_type=mime,
                    headers={"Cache-Control": "no-cache"})
