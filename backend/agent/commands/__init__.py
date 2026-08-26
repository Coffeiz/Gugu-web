"""斜杠控制命令的统一入口。

具体命令按职责拆在本目录的 ``*.py`` 文件中；本文件只负责解析、别名映射和分发。
除目标创建命令外，这些命令在 Web/IM 两条入口都短路执行，不触发主 Agent 或反思；
目标创建命令会先写入 session 状态，再进入主 Agent runner。
"""
from __future__ import annotations

from agent.commands.compact import handle as handle_compact
from agent.commands.help import all_help_text, command_help, is_help_arg
from agent.commands.goal import handle as handle_goal
from agent.commands.unlimited import handle as handle_unlimited
from agent.commands.memory import forget, show_memory
from agent.commands.new import handle as handle_new
from agent.commands.text import normalize_command_text
from agent.commands.workspace import handle as handle_workspace

_PREFIX = ("/", "／")

_COMMANDS: dict[str, str] = {
    "memory": "memory", "mem": "memory",
    "forget": "forget",
    "compact": "compact",
    "goal": "goal",
    "unlimited": "unlimited",
    "new": "new",
    "workspace": "workspace",
    "help": "help", "h": "help",
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


def is_goal_start(text: str, *, allow_leading_mention: bool = False) -> tuple[bool, str]:
    """判断是否为需要立即进入 Agent runner 的目标创建命令。"""
    name, arg = parse(text, allow_leading_mention=allow_leading_mention)
    if name != "goal" or not arg:
        return False, ""
    if arg.lower() in {"status", "状态", "pause", "暂停", "resume", "继续", "恢复",
                       "cancel", "取消", "stop", "help", "帮助"}:
        return False, ""
    return True, arg


async def handle(user_id, text: str, *, session_id: int | None = None,
                 allow_leading_mention: bool = False) -> str | dict | None:
    """命中控制命令 → 返回文本或结构化交互（短路）；否则 None。"""
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
    if name == "goal":
        return await handle_goal(user_id, session_id, arg)
    if name == "unlimited":
        return await handle_unlimited(user_id, session_id, arg)
    if name == "new":
        return await handle_new(user_id, session_id, arg)
    if name == "workspace":
        return await handle_workspace(user_id, session_id, arg)
    return None
