"""Agent 工具输入契约校验。

所有 Tool 仍只维护一份 ``input_schema``；本模块负责在注册期检查 schema 本身，
并把 validator 缓存在 Tool 上，dispatch 时只做实例校验。错误返回只描述字段路径和
违反的规则，不回显模型传入的实际值，避免把潜在敏感参数重复塞进日志/上下文。
"""
from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError

MAX_VALIDATION_ISSUES = 5


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


def invalid_input_payload(tool_name: str, issues: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "error": "tool_input_invalid",
        "tool": tool_name,
        "issues": issues[:MAX_VALIDATION_ISSUES],
    }


__all__ = [
    "SchemaError",
    "build_validator",
    "invalid_input_payload",
    "validate_input",
]
