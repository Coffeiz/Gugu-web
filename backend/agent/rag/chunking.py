"""来源无关的稳定文本切片。"""
from __future__ import annotations

import re

from agent.rag.models import content_hash

_HEADING = re.compile(r"(?m)^(#{1,6})\s+(.+?)\s*$")
_SENTENCE = re.compile(r"(?<=[。！？!?；;\n])")


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


def split_text(text: str, *, max_chars: int = 1400, overlap: int = 120) -> list[str]:
    """优先按段落/句子切分，保证顺序稳定；长度参数是 tokenizer 无关的安全近似。"""
    text = (text or "").strip()
    if not text:
        return []
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]
    chunks: list[str] = []
    buf = ""
    for paragraph in paragraphs:
        pieces = [p.strip() for p in _SENTENCE.split(paragraph) if p.strip()]
        if not pieces:
            continue
        for piece in pieces:
            if len(piece) > max_chars:
                if buf:
                    chunks.append(buf.strip())
                    buf = ""
                for start in range(0, len(piece), max_chars - overlap):
                    chunks.append(piece[start:start + max_chars].strip())
                continue
            candidate = f"{buf}\n{piece}".strip() if buf else piece
            if buf and len(candidate) > max_chars:
                chunks.append(buf.strip())
                tail = buf[-overlap:].strip()
                buf = f"{tail}\n{piece}".strip() if tail else piece
            else:
                buf = candidate
    if buf:
        chunks.append(buf.strip())
    return [chunk for chunk in chunks if chunk]


def chunk_id(document_id: str, version: str, position: int) -> str:
    return f"{document_id}:{version}:{position}"


def text_version(text: str, *parts: object) -> str:
    return content_hash("\x1f".join([*(str(part or "") for part in parts), text]))[:16]
