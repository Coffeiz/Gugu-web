"""Knowledge 写入前的统一规范化与条目构造。"""

from __future__ import annotations

from typing import Any

from .models import KnowledgeEntry, KnowledgeScope
from .store import KnowledgeStore, source_from_input

_SOURCE_TYPES = {"user", "file", "web", "derived", "conversation"}
_CONFIDENCES = {"confirmed", "probable", "unverified"}
_CAPTURE_MODES = {"explicit", "tool_result", "automatic"}
_LIMITS = {"title": 80, "topic": 40, "content": 1000, "source_ref": 300, "source_label": 120}


def normalize_capture(
    title: str, content: str, *, topic: str = "", source_type: str = "user",
    source_ref: str = "", source_label: str = "", confidence: str = "confirmed",
    capture_mode: str = "explicit",
) -> dict[str, str]:
    """校验一次写入请求；超限直接拒绝，不静默截断。"""
    values = {
        "title": str(title or "").strip(), "content": str(content or "").strip(),
        "topic": str(topic or "").strip(), "source_type": str(source_type or "user").strip().lower(),
        "source_ref": str(source_ref or "").strip(), "source_label": str(source_label or "").strip(),
        "confidence": str(confidence or "confirmed").strip().lower(),
        "capture_mode": str(capture_mode or "explicit").strip().lower(),
    }
    if not values["title"] or not values["content"]:
        raise ValueError("需要提供 title 和 content")
    if values["source_type"] not in _SOURCE_TYPES:
        raise ValueError("source_type 只能是 user、file、web、derived 或 conversation")
    if values["confidence"] not in _CONFIDENCES:
        raise ValueError("confidence 只能是 confirmed、probable 或 unverified")
    if values["capture_mode"] not in _CAPTURE_MODES:
        raise ValueError("capture_mode 只能是 explicit、tool_result 或 automatic")
    for name, limit in _LIMITS.items():
        if len(values[name]) > limit:
            raise ValueError(f"{name} 不能超过 {limit} 个字符")
    if values["capture_mode"] != "explicit":
        values["confidence"] = "probable"
    return values


def build_entry(user_id: object, values: dict[str, Any]) -> KnowledgeEntry:
    source = source_from_input(values["source_type"], values["source_ref"], values["source_label"])
    return KnowledgeEntry.create(
        title=values["title"], content=values["content"], topic=values["topic"],
        scope=KnowledgeScope(type="owner", owner_user_id=str(user_id)),
        source=source, confidence=values["confidence"],
    )


async def save_capture(user_id: object, values: dict[str, Any]) -> KnowledgeEntry:
    """统一执行 Knowledge 主数据写入；去重、版本和冲突由 Store 负责。"""
    return await KnowledgeStore(user_id).save(build_entry(user_id, values))


__all__ = ["build_entry", "normalize_capture", "save_capture"]
