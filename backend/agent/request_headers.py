"""自定义 HTTP 请求头校验与工具历史脱敏。"""
from __future__ import annotations

import json
import re
from urllib.parse import urlparse


_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_HEADER_FIELD = re.compile(r"(?i)(?:\"headers\"|'headers'|headers)\s*:")
_FORBIDDEN_HEADERS = frozenset({
    "proxy-authorization", "host", "connection",
    "keep-alive", "proxy-authenticate", "te", "trailer",
    "transfer-encoding", "upgrade", "content-length", "cookie2",
})
_MAX_HEADER_COUNT = 20
_MAX_HEADER_VALUE_BYTES = 8192
_MAX_HEADER_TOTAL_BYTES = 16384
_REDACTED = "[已隐藏]"


def validate_request_headers(headers: object, url: str) -> tuple[dict[str, str | bytes] | None, str | None]:
    """校验用户请求头；非 ASCII 值以 UTF-8 字节发送，且只允许通过 HTTPS。"""
    if headers is None:
        return {}, None
    if not isinstance(headers, dict):
        return None, "headers 必须是对象"
    if len(headers) > _MAX_HEADER_COUNT:
        return None, f"自定义请求头最多 {_MAX_HEADER_COUNT} 个"

    parsed = urlparse(url)
    normalized: dict[str, str | bytes] = {}
    total_bytes = 0
    for raw_name, value in headers.items():
        if not isinstance(raw_name, str) or not _HEADER_NAME.fullmatch(raw_name):
            return None, "请求头名称格式无效"
        name = raw_name.lower()
        if name in normalized:
            return None, "请求头名称不能重复（不区分大小写）"
        if name in _FORBIDDEN_HEADERS:
            return None, f"不允许设置 {raw_name} 请求头"
        if parsed.scheme != "https":
            return None, "自定义请求头仅允许通过 HTTPS 发送"
        if not isinstance(value, str):
            return None, "请求头值必须是字符串"
        encoded_value: str | bytes = value if value.isascii() else value.encode("utf-8")
        value_bytes = encoded_value if isinstance(encoded_value, bytes) else encoded_value.encode("ascii")
        if len(value_bytes) > _MAX_HEADER_VALUE_BYTES:
            return None, "单个请求头值过长"
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            return None, "请求头值不能包含控制字符"
        total_bytes += len(raw_name) + len(value_bytes)
        if total_bytes > _MAX_HEADER_TOTAL_BYTES:
            return None, "自定义请求头总长度过长"
        normalized[name] = encoded_value
    return normalized, None


def request_header_origin(url: str) -> tuple[str, str, int | None] | None:
    """返回请求来源，用于阻止批量请求把凭据发往不同主机。"""
    parsed = urlparse(url if url.startswith(("http://", "https://")) else f"https://{url}")
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    effective_port = port or (443 if parsed.scheme == "https" else 80)
    return parsed.scheme, parsed.hostname.rstrip(".").lower(), effective_port


def redact_tool_request_headers(value):
    """递归隐藏所有自定义请求头值并保留名称；兼容 provider 保存的 JSON 字符串。"""
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return "[请求参数已隐藏]" if _HEADER_FIELD.search(value) else value
        redacted = redact_tool_request_headers(parsed)
        if redacted is parsed:
            return value
        try:
            return json.dumps(redacted, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            return value
    if isinstance(value, list):
        changed = False
        result = []
        for item in value:
            redacted = redact_tool_request_headers(item)
            changed |= redacted is not item
            result.append(redacted)
        return result if changed else value
    if not isinstance(value, dict):
        return value

    changed = False
    result = {}
    for key, item in value.items():
        if str(key).lower() == "headers":
            if isinstance(item, dict):
                hidden = {name: _REDACTED for name in item}
                changed |= any(header_value != _REDACTED for header_value in item.values())
                result[key] = hidden
            else:
                changed |= item != _REDACTED
                result[key] = _REDACTED
            continue
        redacted = redact_tool_request_headers(item)
        changed |= redacted is not item
        result[key] = redacted
    return result if changed else value
