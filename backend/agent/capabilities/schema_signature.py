"""工具 Schema 的紧凑字段签名。"""

from __future__ import annotations


def _required_fields(schema: dict) -> tuple[str, ...] | None:
    fields = schema.get("required", ())
    if not isinstance(fields, (list, tuple)) or not all(isinstance(field, str) for field in fields):
        return None
    return tuple(dict.fromkeys(fields))


def _excluded_fields(schema: dict | None) -> tuple[str, ...] | None:
    if schema is None:
        return ()
    if not isinstance(schema, dict):
        return None
    if "required" in schema:
        fields = _required_fields(schema)
        return fields if fields is not None and len(fields) == 1 else None
    alternatives = schema.get("anyOf")
    if not isinstance(alternatives, list) or not alternatives:
        return None
    fields = []
    for alternative in alternatives:
        required = _required_fields(alternative) if isinstance(alternative, dict) else None
        if required is None or len(required) != 1:
            return None
        fields.extend(required)
    return tuple(dict.fromkeys(fields))


def _mode_constraint(branch: dict) -> tuple[str, tuple[str, ...], tuple[str, ...]] | None:
    if not isinstance(branch, dict):
        return None
    condition, consequence = branch.get("if"), branch.get("then")
    if not isinstance(condition, dict) or not isinstance(consequence, dict):
        return None
    condition_fields = condition.get("properties") or {}
    if not isinstance(condition_fields, dict):
        return None
    mode_schema = condition_fields.get("mode")
    if set(condition_fields) != {"mode"} or "mode" not in condition.get("required", ()):
        return None
    mode = mode_schema.get("const") if isinstance(mode_schema, dict) else None
    required = _required_fields(consequence)
    excluded = _excluded_fields(consequence.get("not"))
    if not isinstance(mode, str) or required is None or excluded is None or not (required or excluded):
        return None
    return mode, required, excluded


def _mode_constraints(schema: dict) -> tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...]:
    """提取可安全压缩的 mode=常量 条件分支及其必填/互斥字段。"""
    branches = schema.get("allOf", ())
    if not isinstance(branches, (list, tuple)):
        return ()
    constraints = (_mode_constraint(branch) for branch in branches)
    return tuple(sorted({item for item in constraints if item is not None}))


def _mode_constraint_signature(schema: dict) -> str:
    """把顶层与结构相同的批量项 mode 互斥规则压成目录短签名。"""
    constraints = _mode_constraints(schema)
    if not constraints:
        return ""
    scopes = ["顶层"]
    for name, child in (schema.get("properties") or {}).items():
        if not isinstance(child, dict):
            continue
        if child.get("type") != "array":
            continue
        item = child.get("items")
        if isinstance(item, dict) and item.get("type") == "object" and _mode_constraints(item) == constraints:
            scopes.append(f"{name}[]")
    clauses = []
    for mode, required, excluded in constraints:
        clause = f"mode={mode}→{'+'.join(required) or '无额外必填'}"
        if excluded:
            clause += f"（不传{'/'.join(excluded)}）"
        clauses.append(clause)
    label = "模式互斥" if any(excluded for _, _, excluded in constraints) else "模式约束"
    summary = f"；{label}（{'、'.join(scopes)}）：{'；'.join(clauses)}"
    return summary if len(summary) <= 520 else "；模式条件较复杂，需读取完整 Schema"


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
    return "、".join(fields) + _mode_constraint_signature(schema)
