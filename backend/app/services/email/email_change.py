"""邮箱变更申请的令牌和状态操作。"""

from __future__ import annotations

from datetime import timedelta
from email.utils import parseaddr
import hashlib
import re
import secrets

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.models import EmailChangeRequest, User


EMAIL_CHANGE_TTL = 30 * 60
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalize_email(value: str) -> str:
    """规范化并校验邮箱；不接受带显示名的地址。"""
    normalized = value.strip().lower()
    if len(normalized) > 300 or not _EMAIL_RE.fullmatch(normalized):
        raise ValueError("请输入有效的邮箱地址")
    parsed = parseaddr(normalized)[1]
    if parsed != normalized:
        raise ValueError("请输入有效的邮箱地址")
    return normalized


def hash_email_change_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def revoke_active_requests(db: AsyncSession, user_id) -> None:
    await db.execute(
        update(EmailChangeRequest)
        .where(
            EmailChangeRequest.user_id == user_id,
            EmailChangeRequest.used_at.is_(None),
            EmailChangeRequest.revoked_at.is_(None),
        )
        .values(revoked_at=now_utc())
    )


async def create_email_change_request(
    db: AsyncSession, user: User, new_email: str,
) -> tuple[EmailChangeRequest, str]:
    """撤销旧申请并创建新申请；调用方负责提交事务。"""
    token = secrets.token_urlsafe(32)
    row = EmailChangeRequest(
        user_id=user.id,
        new_email=normalize_email(new_email),
        token_hash=hash_email_change_token(token),
        expires_at=now_utc() + timedelta(seconds=EMAIL_CHANGE_TTL),
    )
    await revoke_active_requests(db, user.id)
    db.add(row)
    await db.flush()
    return row, token
