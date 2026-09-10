"""/unlimited 命令：切换用户级的无限工具调用模式。"""
from __future__ import annotations

async def handle(user_id, session_id: int | None, arg: str, locale: str | None = None) -> str:
    """切换当前用户的全局工具调用额度设置；session_id 仅为兼容命令接口保留。"""
    from app.db import session as db_session
    from app.models import UserPreferences
    from sqlalchemy import select
    from agent.commands.help import command_help, is_help_arg

    if is_help_arg(arg):
        return command_help("unlimited", locale)
    value = (arg or "").strip().lower()
    if value in {"", "on", "开启", "开", "enable", "enabled"}:
        enabled = True
    elif value in {"off", "关闭", "关", "disable", "disabled"}:
        enabled = False
    elif value in {"status", "状态"}:
        enabled = None
    else:
        return "用法：/unlimited 开启，/unlimited 关闭，/unlimited status。"

    async with db_session._SessionLocal() as db:
        prefs = await db.scalar(select(UserPreferences).where(UserPreferences.user_id == user_id))
        if prefs is None:
            prefs = UserPreferences(user_id=user_id, data_json="{}")
            db.add(prefs)
            await db.flush()
        data = prefs.data
        current = bool(data.get("unlimited_mode", False))
        if enabled is None:
            return ("当前用户的无限工具调用模式已开启。" if current
                    else "当前用户的无限工具调用模式未开启。")
        data["unlimited_mode"] = enabled
        prefs.data = data
        await db.commit()

    return ("已开启用户级无限工具调用模式，仍保留 /stop、上下文预算和服务超时保护。"
            if enabled else "已关闭用户级无限工具调用模式，恢复普通任务的工具调用限制。")
