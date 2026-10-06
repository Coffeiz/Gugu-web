"""文件同步共享的纯路径规范化规则。"""
from __future__ import annotations

import re


def normalize_relative_path(value: str) -> str:
    """将同步相对路径规范为 POSIX 分隔符并拒绝越界路径。"""
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError("同步路径无效")
    path = value.replace("\\", "/")
    if path.startswith("/") or re.match(r"^[A-Za-z]:/", path):
        raise ValueError("同步路径必须是相对路径")
    parts = [part for part in path.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ValueError("同步路径越界")
    return "/".join(parts)
