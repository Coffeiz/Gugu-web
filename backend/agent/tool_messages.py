"""Agent 工具调用消息的共享格式化。"""

from __future__ import annotations

import json


def tool_code_block(value: object, *, language: str = "json", limit: int = 1600) -> str:
    """把工具输入/输出放入有限长度的代码块，避免结构化内容破坏消息排版。"""
    if isinstance(value, str):
        text = value
        language = "text"
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            text = str(value)
    if len(text) > limit:
        text = text[:limit - 1] + "…"
    return f"```{language}\n{text}\n```"


def format_tool_event(event: dict, *, markdown: bool = True) -> str:
    """将工具事件转为统一状态消息，不负责选择发送平台。"""
    label = str(event.get("label") or event.get("name") or "工具").strip()
    event_type = str(event.get("type") or "")
    status = str(event.get("status") or "")
    if not markdown:
        if event_type == "tool_call":
            return ""
        if status in {"success", "ok"}:
            return f"✅ {label}完成"
        if status == "waiting":
            return f"⏸️ {label}：任务已暂停，等待确认"
        return f"⚠️ {label}未完成"

    title = f"### 🔧 {label}"
    if event_type == "tool_call":
        body = [title, "**状态**：执行中"]
        if "input" in event:
            body.extend(("**输入**", tool_code_block(event.get("input"))))
        return "\n\n".join(body)
    if status == "waiting":
        return f"{title}\n\n**状态**：任务已暂停，等待确认"
    status_text = "已完成" if status in {"success", "ok"} else "未完成"
    body = [title, f"**状态**：{status_text}"]
    if event.get("result") is not None:
        body.extend(("**输出**", tool_code_block(event.get("result"))))
    return "\n\n".join(body)
