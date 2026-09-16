"""通用敏感字段交互协议。

这里仅负责交互协议的字段校验和安全完成标记，不负责任何业务凭据落库。
业务模块在校验通过后自行消费 values；敏感值永远不会写入 prompt schema 或响应。
"""
from __future__ import annotations

import re
from typing import Any


_FIELD_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")


def normalize_secret_fields(raw: Any, *, max_fields: int = 16) -> list[dict[str, str]] | None:
    """校验并规范化任意业务可复用的 secret_fields 描述。"""
    if not isinstance(raw, list) or not raw or len(raw) > max_fields:
        return None
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for field in raw:
        if not isinstance(field, dict) or field.get("type", "secret") != "secret":
            return None
        name = str(field.get("name") or "").strip()
        label = str(field.get("label") or name).strip()
        if not _FIELD_NAME.fullmatch(name) or not label or len(label) > 120 or name in seen:
            return None
        seen.add(name)
        result.append({"name": name, "label": label, "type": "secret"})
    return result


def validate_secret_values(fields: list[dict[str, Any]], values: Any) -> dict[str, str]:
    """校验前端提交的 secret 值，只返回当前 prompt 允许的字段。"""
    if not isinstance(values, dict):
        raise ValueError("敏感字段值必须是 JSON 对象")
    allowed = {str(field.get("name") or "") for field in fields}
    if not allowed or set(values) != allowed:
        raise ValueError("敏感字段不匹配")
    normalized: dict[str, str] = {}
    for key, value in values.items():
        if not isinstance(key, str) or not isinstance(value, str) or not value.strip() or len(value) > 4096:
            raise ValueError("敏感字段不能为空或过长")
        normalized[key] = value.strip()
    return normalized


def resolved_prompt_result(prompt_id: int) -> dict[str, Any]:
    """生成不包含敏感值的统一完成结果。"""
    return {
        "kind": "form",
        "status": "answered",
        "prompt_id": prompt_id,
        "option_id": None,
        "value": None,
        "text": "敏感信息已安全保存",
    }
