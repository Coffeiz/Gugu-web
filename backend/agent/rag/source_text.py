"""业务 source record 需要的文本结构化辅助，不负责索引分块。"""
from __future__ import annotations

import re


_HEADING = re.compile(r"(?m)^(#{1,6})\s+(.+?)\s*$")


def split_sections(text: str) -> list[tuple[str, str]]:
    """按 Markdown 标题拆 section，同时保留标题作为检索上下文。"""
    text = (text or "").strip()
    if not text:
        return []
    matches = list(_HEADING.finditer(text))
    if not matches:
        return [("", text)]
    sections: list[tuple[str, str]] = []
    if matches[0].start() > 0 and text[:matches[0].start()].strip():
        sections.append(("", text[:matches[0].start()].strip()))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.end():end].strip()
        if body:
            sections.append((match.group(2).strip(), body))
    return sections
