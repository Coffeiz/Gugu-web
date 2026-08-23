"""/workspace 命令。"""
from __future__ import annotations

from agent.commands.help import command_help, is_help_arg


async def handle(user_id, session_id: int | None, arg: str) -> str:
    if is_help_arg(arg):
        return command_help("workspace")
    if not session_id:
        return "当前还没有会话，暂时不能绑定工作区。"
    from app.db import session as db_session
    from agent.security.shell_policy import session_shell_lock
    from app.services.workspaces import bind_session, describe_session, get_workspace, list_workspaces

    async with session_shell_lock(session_id):
        async with db_session._SessionLocal() as db:
            value = (arg or "").strip()
            if value.lower() in {"list", "列表"}:
                workspaces = await list_workspaces(db, user_id)
                if not workspaces:
                    return "当前没有可绑定的工作区，请先在文件库创建工作区。"
                current = await describe_session(db, user_id, session_id)
                lines = ["可用工作区："]
                for workspace in workspaces:
                    marker = "（当前会话）" if current and current.id == workspace.id else ""
                    lines.append(f"- {workspace.id}：{workspace.name}{marker}")
                lines.append("使用 /workspace <ID> 绑定，例如 /workspace 12。")
                return "\n".join(lines)
            if value.lower() in {"", "show", "查看"}:
                workspace = await describe_session(db, user_id, session_id)
                return (f"当前工作区：{workspace.name}（{workspace.id}）" if workspace
                        else "当前会话未绑定工作区。请在文件库创建/选择工作区后使用 /workspace <ID> 绑定。")
            if value.lower() in {"off", "none", "unbind", "解除", "取消"}:
                try:
                    await bind_session(db, user_id, session_id, None)
                except LookupError:
                    return "当前会话不存在。"
                await db.commit()
                return "已解除当前会话的工作区绑定。"
            try:
                workspace_id = int(value)
            except ValueError:
                return "用法：/workspace 查看，/workspace <工作区ID> 绑定，/workspace 解除。"
            if await get_workspace(db, user_id, workspace_id) is None:
                return "这个工作区不存在，或不属于当前用户。"
            try:
                await bind_session(db, user_id, session_id, workspace_id)
            except LookupError as exc:
                return str(exc)
            await db.commit()
            return f"已将当前会话绑定到工作区 {workspace_id}。"
