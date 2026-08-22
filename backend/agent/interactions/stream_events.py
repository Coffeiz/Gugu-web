"""流式交互事件的编码工具。

当前 Web 和部分 IM 网关仍消费 SSE 文本，因此这里先提供一个稳定的编码边界。
后续切换 WebSocket 或增加按钮确认时，可以复用事件 payload，不必让业务层继续
手写 ``data: ...`` 字符串。
"""
from __future__ import annotations

import json
from typing import Any


def encode_event(event_type: str, /, **payload: Any) -> str:
    """编码一条 SSE data 行；不改变现有事件的 JSON 字段语义。"""
    body = {"type": event_type, **payload}
    return f"data: {json.dumps(body, ensure_ascii=False)}\n\n"


def decode_event(line: str) -> dict[str, Any] | None:
    """解析一条 SSE data 行；格式不合法时返回 None。"""
    if not line.startswith("data: "):
        return None
    raw = line[6:].strip()
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


__all__ = ["decode_event", "encode_event"]
