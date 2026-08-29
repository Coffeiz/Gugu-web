"""snapshot/fixed prefix 消息片段。"""
from __future__ import annotations

from typing import Iterable


def fixed_messages(parts: Iterable[dict], *, system_text: str | None = None,
                  include_system: bool = False) -> list[dict]:
    fixed = list(parts)
    if include_system and system_text:
        return [{"role": "system", "content": system_text}, *fixed]
    return fixed
