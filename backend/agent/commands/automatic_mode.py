"""/auto 命令：查看或修改当前用户的自动模式偏好。"""
from __future__ import annotations

import json

from agent.commands.help import command_help, is_help_arg


def _locale_key(locale: str | None) -> str:
    normalized = (locale or "zh-CN").replace("_", "-").lower()
    if normalized.startswith("en"):
        return "en-US"
    if normalized.startswith("ja"):
        return "ja-JP"
    return "zh-CN"


async def handle(user_id, arg: str, locale: str | None = None) -> str:
    """通过既有用户偏好保存自动模式；无参数时只查询，避免意外开启。"""
    if is_help_arg(arg):
        return command_help("auto", locale)

    value = (arg or "").strip().lower()
    actions = {
        "": "status", "status": "status", "状态": "status",
        "on": "on", "开启": "on", "打开": "on", "开": "on",
        "off": "off", "关闭": "off", "关": "off",
    }
    action = actions.get(value)
    if action is None:
        return {
            "zh-CN": "用法：/auto status 查看状态，/auto on 开启，/auto off 关闭。",
            "en-US": "Usage: /auto status, /auto on, or /auto off.",
            "ja-JP": "使い方: /auto status、/auto on、/auto off。",
        }[_locale_key(locale)]

    from app.core.config import get_settings
    from app.db import session as db_session
    from app.services.account_queries import get_or_create_user_preferences
    from app.services.user_preferences import effective_automatic_mode_enabled

    locale_key = _locale_key(locale)
    messages = {
        "zh-CN": {
            "unavailable": "管理员当前未开放自动模式，暂时不能开启。",
            "enabled": "自动模式已开启。普通操作确认可自动通过；权限授权和强制确认仍需你确认。",
            "disabled": "自动模式已关闭。",
            "already_on": "自动模式已经开启。",
            "already_off": "自动模式已经关闭。",
            "status_on": "自动模式：已开启。普通操作确认可自动通过；权限授权和强制确认仍需你确认。",
            "status_off": "自动模式：已关闭。",
            "admin_off": "管理员当前未开放自动模式，因此不会生效。",
            "invalid_data": "用户偏好数据格式异常，未修改自动模式。",
        },
        "en-US": {
            "unavailable": "Automatic mode is currently disabled by the administrator.",
            "enabled": "Automatic mode is on. Ordinary action confirmations may be skipped; authorization and required confirmations still need your approval.",
            "disabled": "Automatic mode is off.",
            "already_on": "Automatic mode is already on.",
            "already_off": "Automatic mode is already off.",
            "status_on": "Automatic mode: on. Ordinary action confirmations may be skipped; authorization and required confirmations still need your approval.",
            "status_off": "Automatic mode: off.",
            "admin_off": "Automatic mode is disabled by the administrator, so it is not active.",
            "invalid_data": "User preference data is invalid; automatic mode was not changed.",
        },
        "ja-JP": {
            "unavailable": "管理者が自動モードを無効にしているため、現在は有効にできません。",
            "enabled": "自動モードを有効にしました。通常操作の確認は省略できますが、権限付与と必須確認は引き続き必要です。",
            "disabled": "自動モードを無効にしました。",
            "already_on": "自動モードはすでに有効です。",
            "already_off": "自動モードはすでに無効です。",
            "status_on": "自動モード: 有効。通常操作の確認は省略できますが、権限付与と必須確認は引き続き必要です。",
            "status_off": "自動モード: 無効。",
            "admin_off": "管理者が自動モードを無効にしているため、現在は適用されません。",
            "invalid_data": "ユーザー設定の形式が不正なため、自動モードを変更しませんでした。",
        },
    }[locale_key]

    async with db_session._SessionLocal() as db:
        preferences = await get_or_create_user_preferences(db, user_id)
        try:
            data = json.loads(preferences.data_json or "{}")
        except (TypeError, ValueError):
            return messages["invalid_data"]
        if not isinstance(data, dict):
            return messages["invalid_data"]

        current = await effective_automatic_mode_enabled(db, user_id)
        globally_enabled = get_settings().agent.automatic_mode_enabled is True
        if action == "status":
            if current and globally_enabled:
                return messages["status_on"]
            if current and not globally_enabled:
                return f"{messages['status_on']} {messages['admin_off']}"
            return messages["status_off"]
        if action == "on":
            if not globally_enabled:
                return messages["unavailable"]
            if current:
                return messages["already_on"]
            data["automatic_mode_enabled"] = True
            preferences.data_json = json.dumps(data, ensure_ascii=False)
            await db.commit()
            return messages["enabled"]
        if not current:
            return messages["already_off"]
        data["automatic_mode_enabled"] = False
        preferences.data_json = json.dumps(data, ensure_ascii=False)
        await db.commit()
        return messages["disabled"]
