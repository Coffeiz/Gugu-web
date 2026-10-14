"""Telegram MarkdownV2 的保守格式转换与超长消息安全分片。"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

_SPECIAL = re.compile(r"([_\*\[\]\(\)~`>#+\-=|{}.!\\])")
_FENCE_LINE = re.compile(r"^ {0,3}(`{3,}|~{3,})([^\r\n]*)$")
_INLINE_CODE = re.compile(r"`([^`\n]+)`")
_LINK = re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)\)")
_BOLD = re.compile(r"\*\*([^*\n]+?)\*\*")
_ITALIC = re.compile(r"(?<!\*)\*([^*\n]+?)\*(?!\*)")
_UNDERLINE_ITALIC = re.compile(r"(?<!_)_([^_\n]+?)_(?!_)")
_STRIKE = re.compile(r"~~([^~\n]+?)~~")
_HEADING = re.compile(r"(?m)^#{1,6}\s+(.+)$")


def escape_markdown_v2(text: str) -> str:
    return _SPECIAL.sub(r"\\\1", str(text or ""))


def _escape_code(text: str) -> str:
    return str(text or "").replace("\\", "\\\\").replace("`", "\\`")


def _fenced_code_blocks(text: str):
    """读取完整 Markdown 围栏；较短的内层围栏不能截断外层代码块。"""
    lines = text.splitlines(keepends=True)
    offsets = []
    offset = 0
    for line in lines:
        offsets.append(offset)
        offset += len(line)

    index = 0
    while index < len(lines):
        opening_line = lines[index].rstrip("\r\n")
        opening = _FENCE_LINE.fullmatch(opening_line)
        if not opening:
            index += 1
            continue

        marker, info = opening.groups()
        marker_char = marker[0]
        marker_size = len(marker)
        if marker_char == "`" and "`" in info:
            index += 1
            continue

        closing_index = index + 1
        while closing_index < len(lines):
            closing_line = lines[closing_index].rstrip("\r\n")
            closing = _FENCE_LINE.fullmatch(closing_line)
            if (
                closing
                and closing.group(1)[0] == marker_char
                and len(closing.group(1)) >= marker_size
                and not closing.group(2).strip()
            ):
                break
            closing_index += 1

        content_start = offsets[index] + len(lines[index])
        if closing_index == len(lines):
            # Markdown 将未闭合围栏延伸到消息末尾；保持它仍是一个完整代码块。
            yield offsets[index], len(text), info.strip(), text[content_start:]
            return

        content_end = offsets[closing_index]
        block_end = content_end + len(lines[closing_index].rstrip("\r\n"))
        yield offsets[index], block_end, info.strip(), text[content_start:content_end]
        index = closing_index + 1


def _protect_fenced_code_blocks(source: str, keep) -> str:
    """把 Markdown 围栏转成 Telegram 支持的三反引号格式并保护其正文。"""
    blocks = list(_fenced_code_blocks(source))
    if not blocks:
        return source
    output = []
    cursor = 0
    for start, end, info, content in blocks:
        output.append(source[cursor:start])
        language = info.split(maxsplit=1)[0] if info else ""
        if not re.fullmatch(r"[A-Za-z0-9_+-]*", language):
            language = ""
        output.append(keep(f"```{language}\n{_escape_code(content)}```"))
        cursor = end
    output.append(source[cursor:])
    return "".join(output)


def _safe_link(url: str) -> bool:
    try:
        parsed = urlsplit(url)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def markdown_v2(text: str) -> str:
    """保留基础粗体/斜体/链接/代码；未知 Markdown 作为安全文本转义。"""
    source = str(text or "")
    protected: list[str] = []

    def keep(value: str) -> str:
        marker = f"\ue000{len(protected)}\ue001"
        protected.append(value)
        return marker

    source = _protect_fenced_code_blocks(source, keep)
    source = _INLINE_CODE.sub(lambda match: keep(f"`{_escape_code(match.group(1))}`"), source)

    def link(match: re.Match) -> str:
        label, url = match.group(1), match.group(2)
        if not _safe_link(url):
            return keep(escape_markdown_v2(label) + " (" + escape_markdown_v2(url) + ")")
        safe_url = url.replace("\\", "\\\\").replace(")", "\\)")
        return keep(f"[{escape_markdown_v2(label)}]({safe_url})")

    source = _LINK.sub(link, source)
    source = _HEADING.sub(lambda match: keep(f"*{escape_markdown_v2(match.group(1))}*"), source)
    source = _BOLD.sub(lambda match: keep(f"*{escape_markdown_v2(match.group(1))}*"), source)
    source = _STRIKE.sub(lambda match: keep(f"~{escape_markdown_v2(match.group(1))}~"), source)
    source = _ITALIC.sub(lambda match: keep(f"_{escape_markdown_v2(match.group(1))}_"), source)
    source = _UNDERLINE_ITALIC.sub(lambda match: keep(f"_{escape_markdown_v2(match.group(1))}_"), source)
    escaped = escape_markdown_v2(source)
    for index, value in enumerate(protected):
        escaped = escaped.replace(f"\ue000{index}\ue001", value)
    return escaped


def _plain_chunks(text: str, limit: int) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    current_cost = 0
    # 对原文按 Unicode 字符切片，再整体转义，避免切断反斜杠实体或 UTF-8 字符。
    for char in str(text or ""):
        escaped_cost = len(escape_markdown_v2(char))
        utf16_cost = len(char.encode("utf-16-le")) // 2
        cost = max(escaped_cost, utf16_cost)
        if current and current_cost + cost > limit:
            chunks.append(escape_markdown_v2("".join(current)))
            current = []
            current_cost = 0
        current.append(char)
        current_cost += cost
    if current or not chunks:
        chunks.append(escape_markdown_v2("".join(current)))
    return chunks


def split_markdown_v2(text: str, limit: int = 4096) -> list[str]:
    """短消息保留基础 Markdown；超长消息降级为纯文本后按字符安全分片。"""
    raw = str(text or "")
    formatted = markdown_v2(raw)
    formatted_units = len(formatted.encode("utf-16-le")) // 2
    if formatted_units <= limit:
        return [formatted]
    return _plain_chunks(raw, max(1, limit - 32))
