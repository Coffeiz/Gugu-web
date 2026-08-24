"""事件型长期记忆的章节契约。"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re

EVENT_HEADING_PREFIX = "记录长期记忆："
_HEADING_RE = re.compile(r"^##\s*(?P<title>.+?)\s*$")
_DATE_RE = re.compile(r"20\d{2}-\d{1,2}-\d{1,2}")


@dataclass(frozen=True)
class EventSection:
    title: str
    body: str

    @property
    def content_hash(self) -> str:
        return event_hash(self.title, self.body)


def normalize_event_title(title: str, *, fallback: str = "未命名事件") -> str:
    value = re.sub(r"\s+", " ", str(title or "")).strip()
    if value.startswith(EVENT_HEADING_PREFIX):
        value = value[len(EVENT_HEADING_PREFIX):].strip()
    value = value.lstrip("：:·- ").strip()
    return value or fallback


def event_hash(title: str, body: str) -> str:
    payload = f"{normalize_event_title(title)}\n{str(body or '').strip()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def normalize_event_memory(text: str, *, fallback_title: str = "") -> str:
    """规范化 memory 主档标题，保留正文和旧格式兼容。"""
    raw = str(text or "").strip()
    if not raw:
        return ""
    lines = raw.splitlines()
    found = False
    normalized: list[str] = []
    for line in lines:
        match = _HEADING_RE.match(line.strip())
        if match:
            found = True
            normalized.append(f"## {EVENT_HEADING_PREFIX}{normalize_event_title(match.group('title'))}")
        else:
            normalized.append(line.rstrip())
    if found:
        return "\n".join(normalized).strip()
    date_match = _DATE_RE.search(raw)
    title = normalize_event_title(fallback_title or (date_match.group(0) if date_match else "事件记录"))
    return f"## {EVENT_HEADING_PREFIX}{title}\n\n{raw}"


def parse_event_sections(text: str) -> list[EventSection]:
    """解析规范化主档；没有章节时返回空。"""
    normalized = normalize_event_memory(text)
    if not normalized:
        return []
    sections: list[EventSection] = []
    current_title: str | None = None
    body: list[str] = []
    for line in normalized.splitlines():
        match = _HEADING_RE.match(line.strip())
        if match:
            if current_title is not None:
                content = "\n".join(body).strip()
                if content:
                    sections.append(EventSection(current_title, content))
            current_title = normalize_event_title(match.group("title"))
            body = []
        elif current_title is not None:
            body.append(line)
    if current_title is not None:
        content = "\n".join(body).strip()
        if content:
            sections.append(EventSection(current_title, content))
    return sections


def deduplicate_event_sections(text: str) -> str:
    """合并重复事件章节，保持首次出现顺序和后续补充内容。

    模型负责判断事实冲突；这里做确定性的结构整理：相同标题的章节合并，
    相同正文只保留一次，避免跨批次压缩不断追加同一事件。
    """
    sections = parse_event_sections(text)
    if not sections:
        return normalize_event_memory(text)
    merged: list[EventSection] = []
    by_title: dict[str, int] = {}
    seen_hashes: set[str] = set()
    for section in sections:
        content_hash = section.content_hash
        if content_hash in seen_hashes:
            continue
        seen_hashes.add(content_hash)
        index = by_title.get(normalize_event_title(section.title))
        if index is None:
            by_title[normalize_event_title(section.title)] = len(merged)
            merged.append(section)
            continue
        previous = merged[index]
        previous_lines = {line.strip() for line in previous.body.splitlines() if line.strip()}
        additions = [line for line in section.body.splitlines() if line.strip() and line.strip() not in previous_lines]
        if additions:
            merged[index] = EventSection(previous.title, previous.body.rstrip() + "\n" + "\n".join(additions))
    return "\n\n".join(
        f"## {EVENT_HEADING_PREFIX}{normalize_event_title(section.title)}\n\n{section.body.strip()}"
        for section in merged
    ).strip()


__all__ = [
    "EVENT_HEADING_PREFIX", "EventSection", "event_hash",
    "normalize_event_memory", "normalize_event_title", "parse_event_sections",
    "deduplicate_event_sections",
]
