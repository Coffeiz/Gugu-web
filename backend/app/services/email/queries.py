"""邮件相关的归属查询，供 API 和 Agent 编排层复用。"""

from __future__ import annotations

import json

from sqlalchemy import select

from app.models import Client, User, UserPreferences, UserSmtpConfig


async def get_owned_client(db, user_id, client_id):
    return await db.scalar(
        select(Client).where(Client.id == client_id, Client.user_id == user_id)
    )


async def get_user_email(db, user_id) -> str:
    return (await db.scalar(select(User.email).where(User.id == user_id)) or "").strip()


async def get_enabled_user_smtp(db, user_id):
    return await db.scalar(
        select(UserSmtpConfig).where(
            UserSmtpConfig.user_id == user_id,
            UserSmtpConfig.enabled.is_(True),
        )
    )


async def get_user_email_preferences(db, user_id) -> dict:
    data_json = await db.scalar(
        select(UserPreferences.data_json).where(UserPreferences.user_id == user_id)
    )
    try:
        data = json.loads(data_json or "{}")
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


async def get_active_recipient_rows(db):
    return (await db.execute(
        select(User.email, UserPreferences.data_json)
        .outerjoin(UserPreferences, UserPreferences.user_id == User.id)
        .where(User.is_active.is_(True), User.account_status == "active", User.email_subscribed.is_(True))
    )).all()


async def get_user_smtp(db, user_id):
    return await db.scalar(select(UserSmtpConfig).where(UserSmtpConfig.user_id == user_id))


async def save_user_smtp(db, user_id, values: dict, password: str | None = None):
    row = await get_user_smtp(db, user_id)
    if row is None:
        row = UserSmtpConfig(user_id=user_id, password=password or "", **values)
        db.add(row)
    else:
        for field, value in values.items():
            setattr(row, field, value)
        if password is not None:
            row.password = password
    await db.flush()
    return row
