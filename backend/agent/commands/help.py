"""斜杠命令的共享帮助定义。

帮助文案由路由器和命令处理器共同使用，避免 Web/IM 或单个命令各维护一份列表。
"""
from __future__ import annotations

COMMAND_HELP: dict[str, str] = {
    "stop": "/stop　停止当前任务；发送 /stop help 查看说明",
    "status": "/status　查看当前任务状态；发送 /status help 查看说明",
    "compact": "/compact　整理当前会话上下文；发送 /compact help 查看说明",
    "memory": "/memory　查看咕咕记住的内容；发送 /memory help 查看说明",
    "forget": "/forget <内容>　忘记匹配的记忆；发送 /forget help 查看说明",
    "workspace": "/workspace　查看、绑定或解除当前会话工作区；发送 /workspace help 查看说明",
    "shell": "/shell　选择当前会话的 Shell 范围；发送 /shell help 查看说明",
    "help": "/help　查看全部斜杠命令；也可对单个命令发送 /命令 help",
}

COMMAND_DETAILS: dict[str, str] = {
    "stop": (
        "停止当前正在运行的任务。\n"
        "用法：/stop\n"
        "别名：/s、/cancel、/x、/停止、/取消"
    ),
    "status": (
        "查看当前任务所处阶段。\n"
        "用法：/status\n"
        "别名：/状态、/进度"
    ),
    "compact": (
        "立即整理当前会话的旧历史，不创建新会话。\n"
        "用法：/compact\n"
        "别名：/压缩、/整理上下文"
    ),
    "memory": (
        "查看咕咕保存的个人长期记忆。\n"
        "用法：/memory\n"
        "别名：/mem、/记忆、/记得"
    ),
    "forget": (
        "删除与指定内容匹配的个人记忆。\n"
        "用法：/forget <内容>\n"
        "示例：/forget 我喜欢猫\n"
        "别名：/忘记、/忘掉、/忘了"
    ),
    "workspace": (
        "管理当前会话的工作区绑定。\n"
        "用法：/workspace 查看、/workspace list、/workspace <ID>、/workspace 解除\n"
        "解除只取消当前会话绑定，不删除工作区或文件。"
    ),
    "shell": (
        "选择当前会话使用 Shell 的范围。\n"
        "用法：/shell 查看、/shell workspace、/shell personal、/shell system、/shell off\n"
        "workspace 需要绑定工作区；personal 使用个人目录；system 使用系统范围。"
    ),
    "help": (
        "查看全部斜杠命令。\n"
        "用法：/help\n"
        "也可以发送 /命令 help 查看某个命令的详细说明。"
    ),
}


def is_help_arg(arg: str) -> bool:
    return (arg or "").strip().lower() in {"help", "帮助", "?", "？"}


def all_help_text() -> str:
    lines = ["🤖 可用命令（确定性、立即生效）："]
    lines.extend(COMMAND_HELP[name] for name in ("stop", "status", "compact", "memory", "forget", "workspace", "shell", "help"))
    return "\n".join(lines)


def command_help(name: str) -> str:
    return COMMAND_DETAILS.get(name, all_help_text())
