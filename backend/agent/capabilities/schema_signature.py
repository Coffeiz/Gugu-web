"""工具 Schema 的紧凑字段签名。"""

from __future__ import annotations


def field_signature_type(schema: dict, *, depth: int = 0) -> str:
    if not isinstance(schema, dict):
        return "unknown"
    schema_type = schema.get("type")
    if schema_type == "array":
        item = schema.get("items")
        if isinstance(item, dict) and item.get("type") == "object":
            if depth >= 2:
                return "array<object>"
            names = tuple(
                f"{name}:{field_signature_type(value, depth=depth + 1)}"
                for name, value in (item.get("properties") or {}).items()
            )
            return f"array<object:{','.join(names)}>" if names else "array<object>"
        return f"array<{field_signature_type(item, depth=depth + 1)}>" if isinstance(item, dict) else "array"
    if schema_type == "object":
        if depth >= 2:
            return "object"
        names = tuple(
            f"{name}:{field_signature_type(value, depth=depth + 1)}"
            for name, value in (schema.get("properties") or {}).items()
        )
        return f"object:{','.join(names)}" if names else "object"
    if schema_type:
        result = str(schema_type)
        enum = schema.get("enum")
        if isinstance(enum, list) and enum and len(enum) <= 8 and all(
            isinstance(item, (str, int, float, bool)) for item in enum
        ):
            values = "|".join(str(item) for item in enum)
            if len(values) <= 140:
                result = f"{result}[{values}]"
        return result
    choices = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(choices, list):
        types = tuple(field_signature_type(item, depth=depth) for item in choices if isinstance(item, dict))
        return "|".join(dict.fromkeys(types)) or "unknown"
    return "unknown"


def field_signature(schema: dict | None) -> str:
    if not isinstance(schema, dict):
        return ""
    properties = schema.get("properties") or {}
    if not isinstance(properties, dict):
        return ""
    required = set(schema.get("required") or ())
    fields = []
    for name, value in properties.items():
        field = f"{name}({field_signature_type(value)})"
        if name in required:
            field += ",必填"
        fields.append(field)
    return "、".join(fields)
