"""/shell 命令。"""
from __future__ import annotations

from agent.commands.help import command_help, is_help_arg


async def handle(user_id, session_id: int | None, arg: str) -> str:
    if is_help_arg(arg):
        return command_help("shell")
    if not session_id:
        return "当前还没有会话，暂时不能选择 Shell 范围。"
    from app.db import session as db_session
    from agent.security.shell_policy import session_shell_lock
    from app.services.workspaces import get_session_shell_scope, set_session_shell_scope

    aliases = {
        "工作区": "workspace", "workspace": "workspace",
        "个人": "personal", "personal": "personal",
        "全局": "system", "系统": "system", "system": "system",
        "off": "off", "none": "off", "关闭": "off",
    }
    value = (arg or "").strip().lower()
    async with session_shell_lock(session_id):
        async with db_session._SessionLocal() as db:
            if not value:
                current = await get_session_shell_scope(db, user_id, session_id)
                return f"当前 Shell 范围：{current}。可选 workspace、personal、system、off。"
            scope = aliases.get(value)
            if scope is None:
                return "用法：/shell 查看，/shell workspace、/shell personal、/shell system 或 /shell off。"
            try:
                await set_session_shell_scope(db, user_id, session_id, scope)
            except (LookupError, ValueError) as exc:
                return str(exc)
            await db.commit()
            labels = {"off": "关闭", "workspace": "当前工作区", "personal": "个人文件目录", "system": "系统范围"}
            return f"已将当前会话 Shell 范围设为：{labels[scope]}。"
