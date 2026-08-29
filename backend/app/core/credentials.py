"""外部服务凭据的边界校验。"""
from __future__ import annotations


def normalize_ascii_api_key(value: str | None, *, label: str = "API Key") -> str:
    """清理并校验用于 HTTP 鉴权的 token；普通请求正文不应调用此函数。"""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{label} 格式无效")
    normalized = value.strip()
    if not normalized:
        return ""
    try:
        normalized.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{label} 必须使用 ASCII 字符") from exc
    return normalized
