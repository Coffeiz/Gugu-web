"""斜杠控制命令的统一入口。

具体命令按职责拆在 ``command_*.py`` 中；本文件只负责解析、别名映射和分发。
这些命令在 Web/IM 两条入口都短路执行，不触发主 Agent 或反思。
"""
from __future__ import annotations

from agent.commands.compact import handle as handle_compact
from agent.commands.help import all_help_text, command_help, is_help_arg
from agent.commands.memory import forget, show_memory
from agent.commands.shell import handle as handle_shell
from agent.commands.text import normalize_command_text
from agent.commands.workspace import handle as handle_workspace

_PREFIX = ("/", "／")

_COMMANDS: dict[str, str] = {
    "memory": "memory", "mem": "memory", "记忆": "memory", "记得": "memory",
    "你记得什么": "memory", "记得啥": "memory",
    "forget": "forget", "忘记": "forget", "忘掉": "forget", "忘了": "forget",
    "compact": "compact", "压缩": "compact", "整理上下文": "compact",
    "workspace": "workspace", "工作区": "workspace", "工作空间": "workspace",
    "shell": "shell", "命令行": "shell", "终端": "shell",
    "help": "help", "h": "help", "帮助": "help", "菜单": "help", "命令": "help",
}


def parse(text: str, *, allow_leading_mention: bool = False) -> tuple[str | None, str]:
    """拆解 ``/命令 参数``；非本模块命令返回 ``(None, "")``。"""
    normalized = normalize_command_text(text) if allow_leading_mention else (text or "").strip()
    if normalized[:1] not in _PREFIX:
        return None, ""
    body = normalized[1:].strip()
    parts = body.replace("　", " ").split(maxsplit=1)
    if not parts:
        return None, ""
    name = _COMMANDS.get(parts[0].lower())
    return name, parts[1].strip() if len(parts) == 2 else ""


async def handle(user_id, text: str, *, session_id: int | None = None,
                 allow_leading_mention: bool = False) -> str | None:
    """命中控制命令 → 返回回复文本（短路）；否则 None。"""
    name, arg = parse(text, allow_leading_mention=allow_leading_mention)
    if name is None:
        return None
    if name == "help":
        return command_help(arg) if arg and not is_help_arg(arg) else all_help_text()
    if name == "memory":
        return await show_memory(user_id, arg)
    if name == "forget":
        return await forget(user_id, arg)
    if name == "compact":
        return await handle_compact(user_id, session_id, arg)
    if name == "workspace":
        return await handle_workspace(user_id, session_id, arg)
    if name == "shell":
        return await handle_shell(user_id, session_id, arg)
    return None
