"""/goal 命令：创建和管理当前会话的目标任务。

创建目标由入口继续交给 Agent runner 执行；status/pause/resume/cancel 等管理动作仍是短路命令。
"""
from __future__ import annotations

from agent.commands.help import command_help, is_help_arg


async def handle(user_id, session_id: int | None, arg: str) -> str:
    """在当前会话创建、查看、暂停、恢复或取消目标任务。"""
    if is_help_arg(arg):
        return command_help("goal")
    if not session_id:
        return "当前还没有可设置长任务模式的对话。"

    from app.db import session as db_session
    from app.models import ConversationSession

    raw_value = (arg or "").strip()
    value = raw_value.lower()
    if value in {"status", "状态"}:
        action = "status"
    elif value in {"pause", "暂停"}:
        action = "pause"
    elif value in {"resume", "继续", "恢复"}:
        action = "resume"
    elif value in {"cancel", "取消", "stop"}:
        action = "cancel"
    elif raw_value:
        action = "create"
    else:
        return "用法：/goal <目标>、/goal status、/goal cancel。"

    async with db_session._SessionLocal() as db:
        session = await db.get(ConversationSession, session_id)
        if session is None or session.user_id != user_id:
            return "当前会话不存在。"
        context = dict(session.session_context or {})
        if action == "status":
            goal_text = str(context.get("goal_text") or "").strip()
            if not goal_text:
                return "当前会话没有进行中的目标任务。"
            status = "已暂停" if context.get("goal_status") == "paused" else "进行中"
            return f"当前目标任务（{status}）：{goal_text}"
        if action == "pause":
            if not str(context.get("goal_text") or "").strip():
                return "当前会话没有可暂停的目标任务。"
            context["goal_status"] = "paused"
            context["goal_mode"] = False
            session.session_context = context
            await db.commit()
            return "目标任务已暂停。发送 /goal resume 可继续。"
        if action == "resume":
            if not str(context.get("goal_text") or "").strip():
                return "当前会话没有可恢复的目标任务。"
            context["goal_status"] = "active"
            context["goal_mode"] = True
            session.session_context = context
            await db.commit()
            return "目标任务已恢复。"
        if action == "cancel":
            context.pop("goal_text", None)
            context.pop("goal_status", None)
            context["goal_mode"] = False
            session.session_context = context
            await db.commit()
            return "已取消当前目标任务。"
        context["goal_text"] = raw_value
        context["goal_status"] = "active"
        context["goal_mode"] = True
        session.session_context = context
        await db.commit()

    return f"已创建目标任务：{raw_value}\n接下来会持续推进，完成后再结束；也可以发送 /goal pause 暂停或 /goal cancel 取消。"
