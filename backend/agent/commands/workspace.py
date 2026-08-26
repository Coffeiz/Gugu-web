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
    from app.services.workspaces import (
        bind_session,
        delete_workspace,
        describe_session,
        get_workspace,
        list_workspaces,
    )

    async with session_shell_lock(session_id):
        async with db_session._SessionLocal() as db:
            value = (arg or "").strip()
            if value.lower() == "list":
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
            if value.lower() in {"", "show"}:
                workspace = await describe_session(db, user_id, session_id)
                return (f"当前工作区：{workspace.name}（{workspace.id}）" if workspace
                        else "当前会话未绑定工作区。请在文件库创建/选择工作区后使用 /workspace <ID> 绑定。")
            if value.lower() in {"off", "none", "unbind", "unlink"}:
                try:
                    await bind_session(db, user_id, session_id, None)
                except LookupError:
                    return "当前会话不存在。"
                await db.commit()
                return "已解除当前会话的工作区绑定。"
            # 删除是不可逆的控制命令，采用同一命令的显式二次确认，避免误触。
            # 不复用 Agent 工具确认 token：斜杠命令会短路 Agent，且确认状态不应
            # 跨会话持有；用户必须在同一条命令中明确追加 confirm/确认。
            delete_parts = value.split()
            if delete_parts and delete_parts[0].lower() in {"delete", "rm", "remove"}:
                if len(delete_parts) < 2:
                    return "用法：/workspace delete <ID>；确认删除时使用 /workspace delete <ID> confirm。"
                try:
                    workspace_id = int(delete_parts[1])
                except ValueError:
                    return "工作区 ID 必须是数字。用法：/workspace delete <ID> confirm。"
                workspace = await get_workspace(db, user_id, workspace_id)
                if workspace is None:
                    return "这个工作区不存在，或不属于当前用户。"
                confirmed = len(delete_parts) >= 3 and delete_parts[2].lower() in {
                    "confirm", "yes", "y", "确认", "确定",
                }
                if not confirmed:
                    return (
                        f"将永久删除工作区「{workspace.name}」（ID {workspace.id}），"
                        "同时解除绑定，但不会删除项目或文件。"
                        f"请再次发送 /workspace delete {workspace.id} confirm。"
                    )
                await delete_workspace(db, user_id, workspace.id)
                await db.commit()
                return f"已删除工作区「{workspace.name}」（ID {workspace.id}），项目和文件未受影响。"
            try:
                workspace_id = int(value)
            except ValueError:
                return "用法：/workspace 查看，/workspace list 列出，/workspace <ID> 绑定，/workspace unlink 解除，/workspace delete <ID> 删除。"
            if await get_workspace(db, user_id, workspace_id) is None:
                return "这个工作区不存在，或不属于当前用户。"
            try:
                await bind_session(db, user_id, session_id, workspace_id)
            except LookupError as exc:
                return str(exc)
            await db.commit()
            return f"已将当前会话绑定到工作区 {workspace_id}。"
