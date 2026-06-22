from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File as FastAPIFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import User
from app.core.security import hash_password, verify_password, create_user_token, get_current_user
from app.schemas import UserRegister, UserLogin, UserResponse, TokenResponse, UpdateProfile
from app.core.config import get_settings

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=TokenResponse, status_code=201)
async def register(body: UserRegister, db: AsyncSession = Depends(get_db)):
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
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return TokenResponse(
        access_token=create_user_token(user.id),
        user=UserResponse.from_user(user),
    )


@router.post("/login", response_model=TokenResponse)
async def login(body: UserLogin, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.username == body.username))
    user = result.scalars().first()

    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(401, "用户名或密码错误")
    if not user.is_active:
        raise HTTPException(403, "账号已停用，请联系管理员")

    return TokenResponse(
        access_token=create_user_token(user.id),
        user=UserResponse.from_user(user),
    )


@router.get("/me", response_model=UserResponse)
async def me(current_user: User = Depends(get_current_user)):
    return UserResponse.model_validate(current_user)


@router.patch("/profile", response_model=UserResponse)
async def update_profile(
    body: UpdateProfile,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.display_name is not None:
        current_user.display_name = body.display_name.strip() or None

    if body.new_password:
        if not body.current_password:
            raise HTTPException(400, "请输入当前密码")
        if not verify_password(body.current_password, current_user.hashed_password):
            raise HTTPException(400, "当前密码错误")
        current_user.hashed_password = hash_password(body.new_password)

    await db.commit()
    await db.refresh(current_user)
    return UserResponse.from_user(current_user)


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

    ext = (file.filename or "avatar").rsplit(".", 1)[-1].lower() or "jpg"
    settings = get_settings()
    avatar_dir = Path(settings.storage.local_path) / "avatars"
    avatar_dir.mkdir(parents=True, exist_ok=True)
    avatar_path = avatar_dir / f"{current_user.id}.{ext}"
    avatar_path.write_bytes(data)

    current_user.avatar = f"avatars/{current_user.id}.{ext}"
    db.add(current_user)
    await db.commit()
    await db.refresh(current_user)
    return UserResponse.from_user(current_user)


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
                    headers={"Cache-Control": "public, max-age=86400"})
