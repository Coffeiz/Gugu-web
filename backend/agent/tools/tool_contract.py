"""Agent 工具输入契约校验。

所有 Tool 仍只维护一份 ``input_schema``；本模块负责在注册期检查 schema 本身，
并把 validator 缓存在 Tool 上，dispatch 时只做实例校验。错误返回只描述字段路径和
违反的规则，不回显模型传入的实际值，避免把潜在敏感参数重复塞进日志/上下文。
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError

MAX_VALIDATION_ISSUES = 5
_INTEGER_TEXT = re.compile(r"^[+-]?\d+$")


def normalize_tool_name(value: Any) -> str | None:
    """只接受字符串工具名，不把对象、数组等值强制转换成工具名。

    工具名是协议标识，不是业务字段。将错误的 JSON 值转成字符串会把原始
    参数伪装成一个新工具名，最终产生误导性的“未知工具”错误。
    """
    if not isinstance(value, str):
        return None
    name = value.strip()
    return name or None


def normalize_legacy_input(tool_name: str, instance: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """把已知旧调用转换为当前契约，禁止猜测业务数据。"""
    normalized = dict(instance)
    adaptations: list[str] = []
    if tool_name == "create_event" and "all_day" not in normalized:
        normalized["all_day"] = not bool(normalized.get("time") or normalized.get("end_time"))
        adaptations.append("create_event.all_day_inferred")
    return normalized, adaptations


def normalize_input_by_schema(schema: dict[str, Any], instance: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """按工具 Schema 做无歧义的 JSON 类型归一化。

    模型常把 JSON Schema 中的原生标量序列化成字符串；可选数字/布尔字段还可能以
    空字符串表示“未填写”。这里只处理能从 Schema 唯一确定的数字和布尔字段，不修复
    数组/对象的形状，也不把必填空值猜成 0/false，避免容错层掩盖真实参数错误。
    """
    adaptations: list[str] = []

    def schema_types(field_schema: Any) -> set[str]:
        if not isinstance(field_schema, dict):
            return set()
        field_type = field_schema.get("type")
        if isinstance(field_type, str):
            return {field_type}
        if isinstance(field_type, list):
            return {item for item in field_type if isinstance(item, str)}
        return set()

    def normalize_value(value: Any, field_schema: Any, path: str, required: bool) -> Any:
        types = schema_types(field_schema)
        if isinstance(value, dict) and isinstance(field_schema, dict) and "object" in types:
            properties = field_schema.get("properties") or {}
            if not isinstance(properties, dict):
                return value
            result = dict(value)
            required_fields = set(field_schema.get("required") or ())
            for key, child_schema in properties.items():
                if key in result:
                    child = normalize_value(
                        result[key], child_schema, f"{path}.{key}" if path else str(key),
                        key in required_fields,
                    )
                    if child is _OMIT:
                        result.pop(key, None)
                    else:
                        result[key] = child
            return result

        if isinstance(value, list) and isinstance(field_schema, dict) and "array" in types:
            item_schema = field_schema.get("items")
            return [
                normalize_value(item, item_schema, f"{path}[{index}]", True)
                for index, item in enumerate(value)
            ]

        if not isinstance(value, str) or not types.intersection({"boolean", "integer", "number"}):
            return value
        text = value.strip()
        if not text:
            if not required and "null" in types:
                adaptations.append(f"{path}:empty_to_null")
                return None
            if not required:
                adaptations.append(f"{path}:empty_omitted")
                return _OMIT
            return value

        if "boolean" in types:
            boolean_text = text.lower()
            if boolean_text in {"true", "false"}:
                adaptations.append(f"{path}:string_to_boolean")
                return boolean_text == "true"

        integer_text = text
        field_name = path.rsplit(".", 1)[-1]
        if field_name.endswith("_id") and integer_text.startswith("#"):
            integer_text = integer_text[1:]
        if "integer" in types and _INTEGER_TEXT.fullmatch(integer_text):
            adaptations.append(f"{path}:string_to_integer")
            return int(integer_text)
        if "number" in types:
            try:
                number = float(text)
            except ValueError:
                return value
            if math.isfinite(number):
                adaptations.append(f"{path}:string_to_number")
                return number
        return value

    normalized = normalize_value(instance, schema, "", True)
    return ({} if normalized is _OMIT else normalized), adaptations


class _OmitValue:
    pass


_OMIT = _OmitValue()


def build_validator(schema: dict) -> Draft202012Validator:
    """检查并构建全项目统一的 Draft 2020-12 validator。"""
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def _path(parts) -> str:
    text = ".".join(str(part) for part in parts)
    return text or "$"


def _issue(path: str, rule: str, message: str) -> dict[str, str]:
    return {"path": path, "rule": rule, "message": message}


def _issues_for_error(error: ValidationError) -> list[dict[str, str]]:
    path = _path(error.absolute_path)
    rule = str(error.validator or "invalid")

    if rule == "required":
        instance = error.instance if isinstance(error.instance, dict) else {}
        required = error.validator_value if isinstance(error.validator_value, list) else []
        missing = [str(name) for name in required if name not in instance]
        if missing:
            return [
                _issue(
                    f"{path}.{name}" if path != "$" else name,
                    "required",
                    f"缺少必填字段 {name}",
                )
                for name in missing
            ]
        return [_issue(path, "required", "缺少必填字段")]

    if rule == "type":
        expected = error.validator_value
        if isinstance(expected, list):
            expected_text = " / ".join(str(item) for item in expected)
        else:
            expected_text = str(expected)
        return [_issue(path, "type", f"字段类型应为 {expected_text}")]

    if rule == "enum":
        return [_issue(path, "enum", "字段不在允许范围内")]

    if rule == "minimum":
        return [_issue(path, "minimum", f"字段不能小于 {error.validator_value}")]

    if rule == "maximum":
        return [_issue(path, "maximum", f"字段不能大于 {error.validator_value}")]

    if rule == "minLength":
        return [_issue(path, "minLength", f"字段长度不能小于 {error.validator_value}")]

    if rule == "maxLength":
        return [_issue(path, "maxLength", f"字段长度不能大于 {error.validator_value}")]

    if rule == "minItems":
        return [_issue(path, "minItems", f"数组元素数量不能少于 {error.validator_value}")]

    if rule == "maxItems":
        return [_issue(path, "maxItems", f"数组元素数量不能多于 {error.validator_value}")]

    if rule == "additionalProperties":
        return [_issue(path, "additionalProperties", "包含 schema 未允许的额外字段")]

    if rule == "pattern":
        return [_issue(path, "pattern", "字段格式不符合要求")]

    return [_issue(path, rule, f"字段不符合工具输入约束（{rule}）")]


def validate_input(validator: Draft202012Validator, instance: dict) -> list[dict[str, str]]:
    """返回最多 ``MAX_VALIDATION_ISSUES`` 个稳定、脱敏的校验问题。"""
    errors = sorted(
        validator.iter_errors(instance),
        key=lambda error: (_path(error.absolute_path), str(error.validator or "")),
    )
    issues: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for error in errors:
        for item in _issues_for_error(error):
            key = (item["path"], item["rule"], item["message"])
            if key in seen:
                continue
            seen.add(key)
            issues.append(item)
            if len(issues) >= MAX_VALIDATION_ISSUES:
                return issues
    return issues


def _invalid_input_next_action(issues: list[dict[str, str]]) -> str:
    """给模型一个短的纠错动作，不重复注入完整 schema。"""
    missing = [item["path"] for item in issues if item.get("rule") == "required"]
    if missing:
        fields = "、".join(missing[:MAX_VALIDATION_ISSUES])
        return f"请补齐必填字段：{fields}。如果当前对话没有提供且无法可靠推断，请先向用户询问，不要提交空参数重试。"
    return "请根据 issues 修正参数后再调用；不要重复提交相同参数，也不要猜测用户未提供的值。"


def _schema_repair_hints(schema: dict[str, Any] | None, issues: list[dict[str, str]]) -> list[str]:
    """从 schema 生成短修正示例，不回显模型传入的实际参数。"""
    if not isinstance(schema, dict):
        return []

    hints: list[str] = []
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return hints
    for issue in issues:
        path = issue.get("path", "")
        if issue.get("rule") != "type" or "." in path:
            continue
        definition = properties.get(path)
        if not isinstance(definition, dict):
            continue
        expected = definition.get("type")
        if expected == "array":
            item_schema = definition.get("items")
            example = "[]"
            if isinstance(item_schema, dict):
                enum = item_schema.get("enum")
                if isinstance(enum, list) and enum:
                    example = json.dumps([enum[0]], ensure_ascii=False)
            hints.append(f"{path} 必须是数组，例如 {example}；不要传对象。")
        elif expected == "object":
            hints.append(f"{path} 必须是对象（{{...}}），不要传数组或字符串。")
        elif expected == "boolean":
            hints.append(f"{path} 必须是 boolean：使用 true 或 false，不要加引号。")
        elif expected:
            hints.append(f"{path} 必须是 {expected} 类型。")
    return hints


def invalid_input_payload(
    tool_name: str,
    issues: list[dict[str, str]],
    *,
    schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """返回统一、短小且可执行的参数纠错提示；完整 schema 仍由工具声明负责。"""
    bounded = issues[:MAX_VALIDATION_ISSUES]
    payload = {
        "error": "tool_input_invalid",
        "tool": tool_name,
        "issues": bounded,
        "_schema_recovery": {"needed": True, "reason": "validation_error"},
        "usage_hint": "参数不符合工具 schema。先按 issues 修正；缺少无法从上下文确定的必填信息时，先向用户询问。",
        "next_action": _invalid_input_next_action(bounded),
    }
    hints = _schema_repair_hints(schema, bounded)
    if hints:
        payload["schema_hints"] = hints
    return payload


def invalid_tool_call_payload(*, path: str = "name", reason: str = "工具名必须是字符串") -> dict[str, Any]:
    """返回工具调用外层协议错误，不回显模型传入的实际值。"""
    return {
        "error": "tool_call_invalid",
        "issues": [{"path": path, "rule": "type", "message": reason}],
        "usage_hint": "工具调用协议不正确。工具名必须是字符串，arguments 必须是 JSON object。",
        "next_action": "请按工具 Schema 重新组织调用，不要把业务参数对象放到 name 字段。",
    }


def enrich_tool_error(tool_name: str, result: Any) -> Any:
    """给 handler 的业务错误补统一使用规范，保持原返回类型和业务字段。"""
    def _enrich(payload: dict[str, Any]) -> dict[str, Any]:
        if not payload.get("error"):
            return payload
        out = dict(payload)
        out.setdefault("tool", tool_name)
        out.setdefault(
            "usage_hint",
            "工具执行失败。先根据错误信息判断下一步；需要用户补充信息时先询问，不要重复提交相同参数。",
        )
        out.setdefault(
            "next_action",
            "根据错误信息修正或向用户询问缺失信息；确认没有新信息前不要盲目重试。",
        )
        return out

    if isinstance(result, dict):
        return _enrich(result)
    if isinstance(result, str) and result.lstrip().startswith('{"error"'):
        try:
            payload = json.loads(result)
        except Exception:
            return result
        if isinstance(payload, dict):
            return json.dumps(_enrich(payload), ensure_ascii=False)
    return result


__all__ = [
    "SchemaError",
    "build_validator",
    "invalid_input_payload",
    "enrich_tool_error",
    "normalize_legacy_input",
    "normalize_input_by_schema",
    "validate_input",
]
