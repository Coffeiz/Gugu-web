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
