"""Provider 搜索结果预算，保留原生字段并显式报告截断。"""
from __future__ import annotations

import json

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_RESULT_BYTES = 64 * 1024
MAX_TEXT_CHARS = 8000
MAX_ARRAY_ITEMS = 20
_OMIT = object()
_LINK_FIELDS = frozenset({"url", "link", "img_src", "image_url", "site_icon", "logo_url"})
_ENCODER = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"))


def _encoded_size(value) -> int:
    return len(_ENCODER.encode(value).encode("utf-8"))


class _ResultBudget:
    def __init__(self):
        self.remaining = MAX_RESULT_BYTES - 512  # 为截断说明保留空间。
        self.truncated = False

    def copy(self, value, field: str = "", depth: int = 0):
        if depth > 20 or self.remaining < 8:
            self.truncated = True
            return _OMIT
        if isinstance(value, dict):
            return self._copy_dict(value, depth)
        if isinstance(value, list):
            return self._copy_list(value, field, depth)
        if isinstance(value, str):
            value = self._fit_text(value, field)
            if value is _OMIT:
                return _OMIT
        size = _encoded_size(value)
        if size > self.remaining:
            self.truncated = True
            return _OMIT
        self.remaining -= size
        return value

    def _copy_dict(self, value, depth):
        result = {}
        self.remaining -= 2
        # 保留原生状态和计费元数据，避免正文耗尽预算后丢失错误状态。
        keys = sorted(value, key=lambda key: key not in {"base_resp", "usage"})
        for key in keys:
            overhead = _encoded_size(key) + 2
            if overhead + 8 > self.remaining:
                self.truncated = True
                continue
            self.remaining -= overhead
            copied = self.copy(value[key], key, depth + 1)
            if copied is not _OMIT:
                result[key] = copied
        return result

    def _copy_list(self, value, field, depth):
        result = []
        self.remaining -= 2
        if len(value) > MAX_ARRAY_ITEMS:
            self.truncated = True
        for child in value[:MAX_ARRAY_ITEMS]:
            self.remaining -= 1
            copied = self.copy(child, field, depth + 1)
            if copied is _OMIT:
                break
            result.append(copied)
        return result

    def _fit_text(self, value, field):
        if field in _LINK_FIELDS:
            if _encoded_size(value) > self.remaining:
                self.truncated = True
                return _OMIT
            return value
        if len(value) > MAX_TEXT_CHARS:
            value = value[:MAX_TEXT_CHARS]
            self.truncated = True
        if _encoded_size(value) <= self.remaining:
            return value
        self.truncated = True
        low, high = 0, len(value)
        while low < high:
            middle = (low + high + 1) // 2
            if _encoded_size(value[:middle]) <= self.remaining:
                low = middle
            else:
                high = middle - 1
        return value[:low]


def limit_search_result(data: dict) -> dict:
    """预算包含键名和 JSON 结构；链接无法完整保留时省略。"""
    budget = _ResultBudget()
    result = budget.copy(data)
    if budget.truncated:
        result["_gugu_search_limits"] = {
            "truncated": True,
            "max_result_bytes": MAX_RESULT_BYTES,
            "max_text_chars": MAX_TEXT_CHARS,
            "max_array_items": MAX_ARRAY_ITEMS,
            "note": "结果已按预算截断，不能视为完整检索；需要细节时缩小查询范围。",
        }
    return result
