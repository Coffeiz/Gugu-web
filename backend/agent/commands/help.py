"""斜杠命令的共享帮助定义。

帮助文案由路由器和命令处理器共同使用，避免 Web/IM 或单个命令各维护一份列表。
"""
from __future__ import annotations

COMMAND_HELP: dict[str, str] = {
    "stop": "/stop　停止当前任务；发送 /stop help 查看说明",
    "status": "/status　查看当前任务状态；发送 /status help 查看说明",
    "compact": "/compact　整理当前会话上下文；发送 /compact help 查看说明",
    "goal": "/goal <目标>　创建目标任务；发送 /goal help 查看说明",
    "unlimited": "/unlimited　开启或关闭用户级无限工具调用模式；发送 /unlimited help 查看说明",
    "new": "/new　清空当前对话上下文并开始新对话；发送 /new help 查看说明",
    "memory": "/memory　查看咕咕记住的内容；发送 /memory help 查看说明",
    "forget": "/forget <text>　忘记匹配的记忆；发送 /forget help 查看说明",
    "workspace": "/workspace　查看、绑定、解除或删除工作区，并管理当前会话的沙箱权限；发送 /workspace help 查看说明",
    "help": "/help　查看全部斜杠命令；也可对单个命令发送 /<command> help",
}

COMMAND_DETAILS: dict[str, str] = {
    "stop": (
        "停止当前正在运行的任务。\n"
        "/stop　停止当前任务\n"
        "别名：/s、/cancel、/x"
    ),
    "status": (
        "查看当前任务所处阶段。\n"
        "/status　查看当前任务状态\n"
        "别名：无"
    ),
    "compact": (
        "立即整理当前会话的旧历史，不创建新会话。\n"
        "/compact　整理当前会话上下文\n"
        "别名：无"
    ),
    "goal": (
        "创建一个持续推进直到完成的目标任务。\n"
        "/goal <目标>　创建目标任务\n"
        "/goal status　查看目标状态\n"
        "/goal pause　暂停目标任务\n"
        "/goal resume　恢复目标任务\n"
        "/goal cancel　取消目标任务\n"
        "别名：无"
    ),
    "unlimited": (
        "切换当前会话的无限工具调用模式。开启后不受普通任务的工具调用次数限制，仍保留 /stop、"
        "上下文预算和服务超时保护。\n"
        "/unlimited　切换用户级无限工具调用\n"
        "/unlimited on　开启无限工具调用\n"
        "/unlimited off　关闭无限工具调用\n"
        "/unlimited status　查看当前状态\n"
        "无别名"
    ),
    "new": (
        "清空当前会话的消息、摘要、快照和已加载能力，开始一段新的对话。"
        "保留当前会话的工作区绑定、用户设置和权限配置。\n"
        "/new　开始新对话\n"
        "别名：无"
    ),
    "memory": (
        "查看咕咕保存的个人长期记忆。\n"
        "/memory　查看已保存记忆\n"
        "别名：/mem"
    ),
    "forget": (
        "删除与指定内容匹配的个人记忆。\n"
        "/forget <内容>　删除匹配的记忆\n"
        "示例：/forget I like coffee\n"
        "别名：无"
    ),
    "workspace": (
        "管理当前会话的工作区绑定和文件系统授权，也可以删除工作区声明。\n"
        "/workspace show　查看当前绑定\n"
        "/workspace status　查看沙箱权限状态\n"
        "/workspace god　申请完整用户沙箱权限\n"
        "/workspace revoke　撤销完整用户沙箱权限\n"
        "/workspace list　列出可绑定工作区\n"
        "/workspace <ID>　绑定指定工作区\n"
        "/workspace unlink　解除当前会话绑定\n"
        "/workspace delete <ID>　删除工作区（随后确认/取消）\n"
        "/workspace delete <ID> confirm　确认删除工作区\n"
        "解除只取消当前会话绑定；删除会解除所有会话绑定，但不会删除项目或文件。"
    ),
    "help": (
        "查看全部斜杠命令。\n"
        "/help　查看全部命令\n"
        "/<command> help　查看指定命令的详细说明"
    ),
}

COMMAND_HELP_EN = {
    "stop": "/stop - Stop the current task; send /stop help for details",
    "status": "/status - View the current task status; send /status help for details",
    "compact": "/compact - Compact the current conversation; send /compact help for details",
    "goal": "/goal <goal> - Create a goal task; send /goal help for details",
    "unlimited": "/unlimited - Toggle unlimited tool calls; send /unlimited help for details",
    "new": "/new - Start a new conversation; send /new help for details",
    "memory": "/memory - View saved memories; send /memory help for details",
    "forget": "/forget <text> - Forget matching memories; send /forget help for details",
    "workspace": "/workspace - Manage workspace binding and sandbox access; send /workspace help for details",
    "help": "/help - View all slash commands; send /<command> help for details",
}

COMMAND_HELP_JA = {
    "stop": "/stop - 現在のタスクを停止。詳しくは /stop help",
    "status": "/status - 現在のタスク状態を確認。詳しくは /status help",
    "compact": "/compact - 現在の会話を整理。詳しくは /compact help",
    "goal": "/goal <目標> - 目標タスクを作成。詳しくは /goal help",
    "unlimited": "/unlimited - ツール呼び出し無制限モードを切替。詳しくは /unlimited help",
    "new": "/new - 新しい会話を開始。詳しくは /new help",
    "memory": "/memory - 保存したメモリを確認。詳しくは /memory help",
    "forget": "/forget <内容> - 一致するメモリを削除。詳しくは /forget help",
    "workspace": "/workspace - ワークスペースとサンドボックス権限を管理。詳しくは /workspace help",
    "help": "/help - スラッシュコマンド一覧を確認。詳しくは /<command> help",
}

COMMAND_DETAILS_EN = {
    "stop": "Stop the currently running task.\n/stop - Stop the current task\nAliases: /s, /cancel, /x",
    "status": "View the current task stage.\n/status - View the current task status\nNo aliases",
    "compact": "Compact old conversation history without creating a new session.\n/compact - Compact the current conversation\nNo aliases",
    "goal": "Create and manage a goal task.\n/goal <goal> - Create a goal\n/goal status - View the goal\n/goal pause - Pause the goal\n/goal resume - Resume the goal\n/goal cancel - Cancel the goal",
    "unlimited": "Toggle unlimited tool calls. Stop, context budget, and service timeouts still apply.\n/unlimited - Toggle unlimited calls\n/unlimited on - Enable\n/unlimited off - Disable\n/unlimited status - View status",
    "new": "Clear messages, summaries, snapshots, and loaded capabilities, then start a new conversation.\n/new - Start a new conversation\nNo aliases",
    "memory": "View saved personal long-term memories.\n/memory - View saved memories\nAlias: /mem",
    "forget": "Delete personal memories matching the given content.\n/forget <text> - Delete matching memories\nExample: /forget I like coffee",
    "workspace": "Manage the current workspace binding and filesystem access.\n/workspace show - View the current binding\n/workspace status - View sandbox access\n/workspace god - Request full sandbox access\n/workspace revoke - Revoke full sandbox access\n/workspace list - List workspaces\n/workspace <ID> - Bind a workspace\n/workspace unlink - Unbind this session\n/workspace delete <ID> - Delete a workspace, then confirm\n/workspace delete <ID> confirm - Confirm deletion",
    "help": "View all slash commands.\n/help - View all commands\n/<command> help - Details for one command",
}

COMMAND_DETAILS_JA = {
    "stop": "実行中のタスクを停止します。\n/stop - 現在のタスクを停止\n別名: /s、/cancel、/x",
    "status": "現在のタスク段階を確認します。\n/status - 現在のタスク状態を確認\n別名なし",
    "compact": "新しいセッションを作らず、古い会話履歴を整理します。\n/compact - 現在の会話を整理\n別名なし",
    "goal": "目標タスクを作成・管理します。\n/goal <目標> - 目標を作成\n/goal status - 目標を確認\n/goal pause - 一時停止\n/goal resume - 再開\n/goal cancel - キャンセル",
    "unlimited": "ツール呼び出し無制限モードを切り替えます。停止、コンテキスト予算、タイムアウトは適用されます。\n/unlimited - 無制限モードを切替\n/unlimited on - 有効化\n/unlimited off - 無効化\n/unlimited status - 状態確認",
    "new": "メッセージ、要約、スナップショット、読み込み済み機能を消去して新しい会話を開始します。\n/new - 新しい会話を開始\n別名なし",
    "memory": "保存した個人メモリを確認します。\n/memory - 保存したメモリを確認\n別名: /mem",
    "forget": "指定内容に一致する個人メモリを削除します。\n/forget <内容> - 一致するメモリを削除",
    "workspace": "ワークスペースの紐付けとファイルシステム権限を管理します。\n/workspace show - 現在の紐付け\n/workspace status - サンドボックス権限\n/workspace god - 完全権限を申請\n/workspace revoke - 完全権限を取消\n/workspace list - ワークスペース一覧\n/workspace <ID> - 紐付け\n/workspace unlink - このセッションの紐付けを解除\n/workspace delete <ID> - 削除して確認\n/workspace delete <ID> confirm - 削除を確認",
    "help": "スラッシュコマンド一覧を表示します。\n/help - コマンド一覧を確認\n/<command> help - 各コマンドの詳細",
}


def _locale_key(locale: str | None) -> str:
    normalized = (locale or "zh-CN").replace("_", "-").lower()
    if normalized.startswith("en"):
        return "en-US"
    if normalized.startswith("ja"):
        return "ja-JP"
    return "zh-CN"

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
    "workspace": ("工作区", "查看、绑定、删除工作区或管理沙盒权限", "/workspace "),
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


def all_help_text(locale: str | None = None) -> str:
    locale_key = _locale_key(locale)
    catalog = COMMAND_HELP_EN if locale_key == "en-US" else COMMAND_HELP_JA if locale_key == "ja-JP" else COMMAND_HELP
    title = "🤖 Available commands (deterministic and immediate):" if locale_key == "en-US" else "🤖 利用可能なコマンド（確定的・即時実行）:" if locale_key == "ja-JP" else "🤖 可用命令（确定性、立即生效）："
    lines = [title]
    lines.extend(catalog[name] for name in ("stop", "status", "compact", "goal", "unlimited", "new", "memory", "forget", "workspace", "help"))
    return "\n".join(lines)


def command_help(name: str, locale: str | None = None) -> str:
    locale_key = _locale_key(locale)
    catalog = COMMAND_DETAILS_EN if locale_key == "en-US" else COMMAND_DETAILS_JA if locale_key == "ja-JP" else COMMAND_DETAILS
    return catalog.get(name, all_help_text(locale))
