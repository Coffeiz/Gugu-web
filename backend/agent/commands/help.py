"""斜杠命令的共享帮助定义。

帮助文案由路由器和命令处理器共同使用，避免 Web/IM 或单个命令各维护一份列表。
"""
from __future__ import annotations

COMMAND_HELP: dict[str, str] = {
    "stop": "/stop　停止当前任务；发送 /stop help 查看说明",
    "status": "/status　查看当前任务状态；发送 /status help 查看说明",
    "compact": "/compact　整理当前会话上下文；发送 /compact help 查看说明",
    "goal": "/goal <目标>　创建目标任务；发送 /goal help 查看说明",
    "unlimited": "/unlimited　开启或关闭当前会话的无限工具调用模式；发送 /unlimited help 查看说明",
    "new": "/new　清空当前对话上下文并开始新对话；发送 /new help 查看说明",
    "memory": "/memory　查看咕咕记住的内容；发送 /memory help 查看说明",
    "forget": "/forget <text>　忘记匹配的记忆；发送 /forget help 查看说明",
    "workspace": "/workspace　查看、绑定、解除或删除工作区；发送 /workspace help 查看说明",
    "help": "/help　查看全部斜杠命令；也可对单个命令发送 /<command> help",
}

COMMAND_DETAILS: dict[str, str] = {
    "stop": (
        "停止当前正在运行的任务。\n"
        "用法：/stop\n"
        "别名：/s、/cancel、/x"
    ),
    "status": (
        "查看当前任务所处阶段。\n"
        "用法：/status\n"
        "无别名"
    ),
    "compact": (
        "立即整理当前会话的旧历史，不创建新会话。\n"
        "用法：/compact\n"
        "无别名"
    ),
    "goal": (
        "创建一个持续推进直到完成的目标任务。\n"
        "用法：/goal <目标>、/goal status、/goal pause、/goal resume、/goal cancel\n"
        "无别名"
    ),
    "unlimited": (
        "切换当前会话的无限工具调用模式。开启后不受普通任务的工具调用次数限制，仍保留 /stop、"
        "上下文预算和服务超时保护。\n"
        "用法：/unlimited、/unlimited on、/unlimited off、/unlimited status\n"
        "无别名"
    ),
    "new": (
        "清空当前会话的消息、摘要、快照和已加载能力，开始一段新的对话。"
        "保留当前会话的工作区绑定、用户设置和权限配置。\n"
        "用法：/new\n"
        "无别名"
    ),
    "memory": (
        "查看咕咕保存的个人长期记忆。\n"
        "用法：/memory\n"
        "别名：/mem"
    ),
    "forget": (
        "删除与指定内容匹配的个人记忆。\n"
        "用法：/forget <内容>\n"
        "示例：/forget I like coffee\n"
        "无别名"
    ),
    "workspace": (
        "管理当前会话的工作区绑定，也可以删除工作区声明。\n"
        "用法：/workspace show、/workspace list、/workspace <ID>、/workspace unlink\n"
        "删除：/workspace delete <ID>，随后点击确认/取消；也支持 /workspace delete <ID> confirm。\n"
        "解除只取消当前会话绑定；删除会解除所有会话绑定，但不会删除项目或文件。"
    ),
    "help": (
        "查看全部斜杠命令。\n"
        "用法：/help\n"
        "也可以发送 /<command> help 查看某个命令的详细说明。"
    ),
}

# 前端命令菜单从这里读取，避免 Web/IM 再维护一份可见命令清单。
COMMAND_MENU: dict[str, tuple[str, str, str]] = {
    "stop": ("停止当前任务", "立即停止正在进行的任务", "/stop"),
    "status": ("查看进度", "查看当前任务状态", "/status"),
    "compact": ("整理上下文", "压缩当前会话的旧对话", "/compact"),
    "goal": ("目标任务", "创建一个持续推进的目标", "/goal "),
    "unlimited": ("解除工具限制", "解除当前任务的工具调用次数限制", "/unlimited"),
    "new": ("开启新对话", "清空当前对话上下文", "/new"),
    "memory": ("查看记忆", "查看咕咕记住的内容", "/memory"),
    "forget": ("忘记一条记忆", "输入要忘记的内容", "/forget "),
    "workspace": ("工作区", "查看、绑定或删除工作区", "/workspace "),
    "help": ("命令帮助", "查看全部命令说明", "/help"),
}


def command_menu() -> list[dict[str, str]]:
    """返回前端命令菜单；菜单只展示规范命令，不展示别名。"""
    return [
        {"command": f"/{name}", "label": label, "description": description, "insert": insert}
        for name, (label, description, insert) in COMMAND_MENU.items()
    ]


def is_help_arg(arg: str) -> bool:
    return (arg or "").strip().lower() in {"help", "?", "？"}


def all_help_text() -> str:
    lines = ["🤖 可用命令（确定性、立即生效）："]
    lines.extend(COMMAND_HELP[name] for name in ("stop", "status", "compact", "goal", "unlimited", "new", "memory", "forget", "workspace", "help"))
    return "\n".join(lines)


def command_help(name: str) -> str:
    return COMMAND_DETAILS.get(name, all_help_text())
