"""上下文 canonical event 的统一序列化约定。

当前注入、历史恢复和 provider wire 渲染都必须使用同一种事件边界。
这里不负责业务召回，只负责识别和构造可稳定重放的上下文 block。
"""
from __future__ import annotations

from typing import Any


CANONICAL_CONTEXT_EVENT_TYPES = frozenset({
    "tool-schema", "skill-schema", "tool-discovery", "knowledge-context", "stance-context", "time-context",
})
def knowledge_context_block(*, scope: str, text: str,
                            content_hash: str = "",
                            content_hashes: list[str] | tuple[str, ...] = ()) -> dict[str, Any]:
    """构造唯一的知识上下文 block，内部元数据不进入 provider 正文。"""
    block: dict[str, Any] = {
        "type": "knowledge-context",
        "scope": str(scope),
        "text": str(text),
    }
    if content_hash:
        block["content_hash"] = str(content_hash)
    if content_hashes:
        block["content_hashes"] = [str(value) for value in content_hashes]
    return block


__all__ = [
    "CANONICAL_CONTEXT_EVENT_TYPES",
    "knowledge_context_block",
]
