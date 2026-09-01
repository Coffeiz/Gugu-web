"""文本行级编辑的共享实现。

行号对外使用 1-based 的 ``8``、``8-11`` 或 Bash 风格的 ``8,11``；内部统一
成闭区间，并从后往前应用，避免前面的删除改变后续目标行号。
"""
from __future__ import annotations

import re
from typing import Any

_TARGET_LINES = re.compile(r"^\s*(\d+)(?:\s*[-,]\s*(\d+))?\s*$")


def _parse_target(value: Any, line_count: int) -> tuple[int, int]:
    if not isinstance(value, str):
        raise ValueError("target_lines 必须是 all、行号或行号范围，例如 8、8-11 或 8,11")
    if value.strip().lower() == "all":
        return 1, line_count
    match = _TARGET_LINES.fullmatch(value)
    if not match:
        raise ValueError("target_lines 格式无效，请使用 all、8、8-11 或 8,11")
    start = int(match.group(1))
    end = int(match.group(2) or start)
    if start < 1 or end < start or end > line_count:
        raise ValueError(f"target_lines 超出范围，当前正文共有 {line_count} 行")
    return start, end


def numbered_lines(text: str) -> str:
    """返回供模型定位用的原始物理行号，不经过 Markdown 渲染。"""
    lines = text.splitlines()
    return "\n".join(f"{index}: {line}" for index, line in enumerate(lines, 1))


def _normalise_expected(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")


def apply_line_edits(text: str, edits: list[dict[str, Any]]) -> tuple[str, int]:
    """按 target_lines 替换整行；数字行必须用 expected 校验原文。"""
    if not isinstance(edits, list) or not edits:
        raise ValueError("line_edits 不能为空")
    lines = text.splitlines(keepends=True)
    parsed: list[tuple[int, int, str, str | None]] = []
    for edit in edits:
        if not isinstance(edit, dict):
            raise ValueError("line_edits 每项必须是对象")
        start, end = _parse_target(edit.get("target_lines"), len(lines))
        content = edit.get("content", "")
        if not isinstance(content, str):
            raise ValueError("line_edits.content 必须是字符串")
        expected = edit.get("expected")
        if expected is not None and not isinstance(expected, str):
            raise ValueError("line_edits.expected 必须是字符串")
        if str(edit.get("target_lines", "")).strip().lower() != "all" and expected is None:
            raise ValueError("数字行编辑必须提供 expected 原文，请先读取最新正文并按原始物理行号定位")
        parsed.append((start, end, content, expected))
    ordered = sorted(parsed, key=lambda item: item[0], reverse=True)
    for (higher_start, _, _, _), (start, end, _, _) in zip(ordered, ordered[1:]):
        if end >= higher_start:
            raise ValueError("line_edits 的目标行范围不能重叠")
    for start, end, content, expected in ordered:
        old_segment = lines[start - 1:end]
        if expected is not None:
            actual = _normalise_expected("".join(old_segment))
            if actual != _normalise_expected(expected):
                raise ValueError(
                    f"target_lines {start}-{end} 的原文校验失败；正文可能已变化，请重新读取后再编辑"
                )
        replacement = content
        if replacement and old_segment and old_segment[-1].endswith(("\n", "\r")) and not replacement.endswith(("\n", "\r")):
            replacement += "\n"
        lines[start - 1:end] = replacement.splitlines(keepends=True) if replacement else []
    return "".join(lines), sum(end - start + 1 for start, end, _, _ in parsed)
