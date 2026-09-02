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
_NOTE_SCHEMA_HINTS = [
    "请重新生成完整的 blocks/append_blocks 数组，不要只改报错字段。",
    "paragraph/heading 使用 content 数组；bullet_list/ordered_list/task_list 使用 items 数组；blockquote 使用 paragraphs 数组。",
    "列表和待办只支持扁平项：列表项只能是 {content:[{type:text/reference,...}]}，待办项只能是 {checked:boolean,content:[{type:text/reference,...}]}。",
    "note_update 的 line_edits 使用 {target_lines,expected,content}：数字 target_lines 必须匹配 note_get.numbered_content 的原始物理行，整篇才使用 all；content 为空表示删除指定行；不要与 append_blocks 同时传。",
    "行内对象必须带 type；不要在列表项内嵌套列表、content 或 paragraphs，也不要把数组包装成 {item:[...]}。",
]


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
    if tool_name == "send_email":
        # 部分模型会把复杂 JSON 参数再次序列化成字符串；只对邮件工具已声明为
        # 数组的字段做严格解析，解析结果仍需通过当前 Schema，不能借此放宽契约。
        for field in ("sections", "actions"):
            value = normalized.get(field)
            if not isinstance(value, str):
                continue
            try:
                decoded = json.loads(value)
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(decoded, list):
                normalized[field] = decoded
                adaptations.append(f"{tool_name}.{field}:json_string_to_array")
    if tool_name in {"create_project", "set_color"} and isinstance(normalized.get("color"), str):
        # 兼容旧版本已经生成的 CSS 渐变参数；新的模型 schema 只暴露语义色名。
        from app.core.project_colors import project_color_key

        color_key = project_color_key(normalized["color"])
        if color_key != normalized["color"]:
            normalized["color"] = color_key
            adaptations.append(f"{tool_name}.color:normalized_token")
    if tool_name == "create_event" and "all_day" not in normalized:
        normalized["all_day"] = not bool(normalized.get("time") or normalized.get("end_time"))
        adaptations.append("create_event.all_day_inferred")

    date_fields = {
        "create_event": ("date",),
        "list_events": ("from", "to"),
        "update_event": ("date", "on_date"),
        "delete_event": ("on_date",),
        "add_event_reminder": ("on_date",),
        "list_event_reminders": ("on_date",),
        "remove_event_reminder": ("on_date",),
        "create_project": ("start_date", "deadline"),
        "update_project": ("start_date", "deadline"),
    }.get(tool_name, ())
    if date_fields:
        from app.core.date_input import normalize_date_string

        for field in date_fields:
            value = normalized.get(field)
            if isinstance(value, str):
                try:
                    canonical = normalize_date_string(value)
                    if canonical != value:
                        normalized[field] = canonical
                        adaptations.append(f"{tool_name}.{field}:normalized_date")
                except ValueError:
                    pass  # 交给当前工具 Schema 返回脱敏的格式错误

    if tool_name in {"note_create", "note_update"}:
        # 旧版笔记调用把纯文本行内节点写成 {"text": "..."}。type 只有
        # text/reference 两种可能，且存在 text 时只能无歧义地归一成 text；引用
        # 节点没有 type 时仍然拒绝，避免把业务数据猜成另一种引用。
        def normalize_note_nodes(value: Any, path: str) -> Any:
            if isinstance(value, list):
                return [
                    normalize_note_nodes(item, f"{path}[{index}]")
                    for index, item in enumerate(value)
                ]
            if not isinstance(value, dict):
                return value

            result = dict(value)
            if "text" in result and "type" not in result:
                result["type"] = "text"
                adaptations.append(f"{path}.type:inferred_text")

            for key in ("content", "items", "paragraphs"):
                if key in result:
                    result[key] = normalize_note_nodes(result[key], f"{path}.{key}")
            return result

        for field in ("blocks", "append_blocks"):
            if field in normalized:
                normalized[field] = normalize_note_nodes(normalized[field], field)
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
        if issue.get("rule") not in {"type", "enum"} or "." in path:
            continue
        definition = properties.get(path)
        if not isinstance(definition, dict):
            continue
        expected = definition.get("type")
        if issue.get("rule") == "enum" and isinstance(definition.get("enum"), list):
            allowed = "、".join(str(item) for item in definition["enum"])
            hints.append(f"{path} 必须是允许的枚举值：{allowed}。不要传视觉描述或 CSS 值。")
        elif expected == "array":
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
    if tool_name in {"note_create", "note_update"}:
        payload["next_action"] = "笔记结构错误，请按 schema_hints 重建完整 blocks；不要沿用原来的嵌套结构或 item 包装。"
        hints = [*hints, *_NOTE_SCHEMA_HINTS]
    if hints:
        payload["schema_hints"] = hints
    return payload


def invalid_tool_call_payload(
    *, path: str = "name", reason: str = "工具名必须是字符串", rule: str = "type"
) -> dict[str, Any]:
    """返回工具调用外层协议错误，不回显模型传入的实际值。"""
    next_action = "请按工具 Schema 重新组织调用，不要把业务参数对象放到 name 字段。"
    if path == "arguments" and rule == "required":
        next_action = "请先获取目标工具的完整 Schema，再通过 arguments 传入全部业务参数。"
    elif path == "arguments":
        next_action = "请先获取目标工具的完整 Schema，并确保 arguments 是 JSON object。"
    return {
        "error": "tool_call_invalid",
        "issues": [{"path": path, "rule": rule, "message": reason}],
        "usage_hint": "工具调用协议不正确。工具名必须是字符串，arguments 必须是 JSON object。",
        "next_action": next_action,
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
