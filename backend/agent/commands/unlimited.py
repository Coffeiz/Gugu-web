"""/unlimited 命令：切换当前会话的无限工具调用模式。"""
from __future__ import annotations

async def handle(user_id, session_id: int | None, arg: str) -> str:
    """切换当前会话的无限工具调用模式。"""
    from app.db import session as db_session
    from app.models import ConversationSession
    from agent.commands.help import command_help, is_help_arg

    if is_help_arg(arg):
        return command_help("unlimited")
    if not session_id:
        return "当前还没有可设置工具调用额度的对话。"
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
        session = await db.get(ConversationSession, session_id)
        if session is None or session.user_id != user_id:
            return "当前会话不存在。"
        context = dict(session.session_context or {})
        current = bool(context.get("unlimited_mode") or (context.get("goal_mode", False) and not context.get("goal_text")))
        if enabled is None:
            return ("当前会话的无限工具调用模式已开启。" if current
                    else "当前会话的无限工具调用模式未开启。")
        # 无限模式只解除本次 run 的工具调用次数上限，不复用 goal_mode，避免进入目标任务循环。
        context["unlimited_mode"] = enabled
        if enabled and context.get("goal_mode") and not context.get("goal_text"):
            context["goal_mode"] = False
        if not enabled and context.get("goal_mode") and not context.get("goal_text"):
            context["goal_mode"] = False
        session.session_context = context
        await db.commit()

    return ("已开启无限工具调用模式，仍保留 /stop、上下文预算和服务超时保护。"
            if enabled else "已关闭无限工具调用模式，恢复普通任务的工具调用限制。")
