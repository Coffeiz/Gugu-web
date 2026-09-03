"""工具调用 JSON Schema 契约回归。

验证边界在 SkillRegistry.dispatch：合法 JSON 但 schema 不合法时必须在 DB/handler 前拒绝，
并保留既有的整数 ID 弱归一化。错误结果不能回显实际非法值。
"""
import json

import pytest
from sqlalchemy import select

from app.models import Project
from app.core.project_colors import PROJECT_COLOR_KEYS, PROJECT_COLOR_PRESETS, project_color_key, project_color_value

import agent.tools.base as tool_base
from agent.tools.base import SkillRegistry, Tool, ToolContractError, registry as global_registry
from agent.tools.mind import _BLOCK_ITEM_SCHEMA, _parse_captured_at
from app.core.tz import LOCAL_TZ
from app.core.date_input import normalize_date_string
from agent.tools.tool_contract import (
    build_validator,
    invalid_input_payload,
    normalize_input_by_schema,
    normalize_legacy_input,
    validate_input,
)


async def _ok_handler(db, user_id, args):
    return {"ok": True, "args": args}


def _make_registry(schema, handler=_ok_handler, *, mutates=False):
    reg = SkillRegistry()
    tool = Tool(
        name="schema_test_tool",
        description="schema test",
        input_schema=schema,
        handler=handler,
        mutates=mutates,
    )
    reg.add(tool)
    return reg, tool


def test_send_email_normalizes_json_string_arrays_without_widening_schema():
    normalized, adaptations = normalize_legacy_input("send_email", {
        "sections": '[{"heading":"状态","text":"执行中"}]',
        "actions": '[{"label":"打开项目","url":"https://example.com"}]',
        "confirm": "true",
    })

    assert normalized["sections"] == [{"heading": "状态", "text": "执行中"}]
    assert normalized["actions"] == [{"label": "打开项目", "url": "https://example.com"}]
    assert normalized["confirm"] == "true"
    assert adaptations == [
        "send_email.sections:json_string_to_array",
        "send_email.actions:json_string_to_array",
    ]


@pytest.mark.parametrize("bad_input", [[], "query", 7, None])
async def test_dispatch_rejects_non_object_before_handler(bad_input, monkeypatch):
    called = False

    async def handler(db, user_id, args):
        nonlocal called
        called = True
        return {"ok": True}

    reg, _ = _make_registry({"type": "object"}, handler)
    raw, artifact = await reg.dispatch("not-a-uuid", "schema_test_tool", bad_input)

    payload = json.loads(raw)
    assert artifact is None
    assert payload["error"] == "tool_input_invalid"
    assert payload["issues"][0]["rule"] == "type"
    assert called is False


async def test_dispatch_rejects_missing_required_before_handler():
    called = False

    async def handler(db, user_id, args):
        nonlocal called
        called = True
        return {"ok": True}

    reg, _ = _make_registry({
        "type": "object",
        "properties": {"project_id": {"type": "integer"}},
        "required": ["project_id"],
    }, handler)

    raw, _ = await reg.dispatch("not-a-uuid", "schema_test_tool", {})
    payload = json.loads(raw)

    assert payload["error"] == "tool_input_invalid"
    assert {item["path"] for item in payload["issues"]} == {"project_id"}
    assert {item["rule"] for item in payload["issues"]} == {"required"}
    assert "usage_hint" in payload
    assert "project_id" in payload["next_action"]
    assert "先向用户询问" in payload["next_action"]
    assert called is False


def test_note_tools_accept_legacy_text_inline_nodes_and_keep_strict_schema():
    raw = {
        "blocks": [
            {"type": "heading", "content": [{"text": "日记标题"}]},
            {"type": "paragraph", "content": [{"text": "正文"}]},
            {"type": "bullet_list", "items": [{"content": [{"text": "列表项"}]}]},
        ],
    }

    normalized, adaptations = normalize_legacy_input("note_create", raw)
    issues = validate_input(
        build_validator({
            "type": "object",
            "properties": {"blocks": {"type": "array", "items": _BLOCK_ITEM_SCHEMA}},
            "required": ["blocks"],
        }),
        normalized,
    )

    assert issues == []
    assert normalized["blocks"][0]["content"][0] == {"text": "日记标题", "type": "text"}
    assert normalized["blocks"][2]["items"][0]["content"][0]["type"] == "text"
    assert len(adaptations) == 3


def test_note_tools_do_not_guess_missing_reference_type():
    raw = {"blocks": [{"type": "paragraph", "content": [{"label": "项目"}]}]}

    normalized, adaptations = normalize_legacy_input("note_create", raw)

    assert normalized == raw
    assert adaptations == []


@pytest.mark.parametrize("value", [
    "08-23", "08/23", "2026-08-23", "2026/08/23", "08-23-2026",
    "26-08-23", "08-23-26", "2026年8月23日", "8月23日",
])
def test_note_date_parser_accepts_common_model_date_formats(value):
    parsed = _parse_captured_at(value).astimezone(LOCAL_TZ)

    assert parsed.month == 8
    assert parsed.day == 23


def test_note_date_parser_uses_noon_anchor_without_model_sort_time():
    parsed = _parse_captured_at("2026-08-23").astimezone(LOCAL_TZ)

    assert parsed.hour == 12
    assert parsed.minute == 0
    assert parsed.second == 0


def test_all_date_fields_share_canonical_normalization_before_schema_validation():
    event, event_adaptations = normalize_legacy_input("create_event", {
        "title": "评审", "date": "08/23", "all_day": True,
    })
    project, project_adaptations = normalize_legacy_input("create_project", {
        "name": "项目", "start_date": "26-08-20", "deadline": "2026年8月23日",
    })

    assert event["date"] == "2026-08-23"
    assert event_adaptations == ["create_event.date:normalized_date"]
    assert project["start_date"] == "2026-08-20"
    assert project["deadline"] == "2026-08-23"
    assert project_adaptations == [
        "create_project.start_date:normalized_date",
        "create_project.deadline:normalized_date",
    ]
    assert normalize_date_string("2026-08-23") == "2026-08-23"


async def test_dispatch_rejects_type_enum_and_numeric_boundaries():
    reg, _ = _make_registry({
        "type": "object",
        "properties": {
            "mode": {"type": "string", "enum": ["basic", "advanced"]},
            "max_results": {"type": "integer", "minimum": 1, "maximum": 20},
        },
        "required": ["mode", "max_results"],
    })

    raw, _ = await reg.dispatch(
        "not-a-uuid",
        "schema_test_tool",
        {"mode": "VERY_SECRET_BAD_VALUE", "max_results": 99},
    )
    payload = json.loads(raw)

    assert payload["error"] == "tool_input_invalid"
    assert {(item["path"], item["rule"]) for item in payload["issues"]} == {
        ("max_results", "maximum"),
        ("mode", "enum"),
    }
    assert "VERY_SECRET_BAD_VALUE" not in raw


async def test_type_error_includes_schema_shape_hint_without_echoing_input():
    reg, _ = _make_registry({
        "type": "object",
        "properties": {
            "channels": {
                "type": "array",
                "items": {"type": "string", "enum": ["web", "qq"]},
            },
        },
    })

    # {"item": "qq"} 是模型把单元素数组包装成对象的退化形态，键名固定无歧义，
    # normalize_input_by_schema 应解除包装而不是报类型错误。
    raw, _ = await reg.dispatch("not-a-uuid", "schema_test_tool", {
        "channels": {"item": "qq"},
    })
    payload = json.loads(raw)

    assert payload["ok"] is True
    assert payload["args"]["channels"] == ["qq"]
    assert '"item": "qq"' not in raw


async def test_boolean_type_error_explains_native_json_value():
    reg, _ = _make_registry({
        "type": "object",
        "properties": {"confirm": {"type": "boolean"}},
    })

    raw, _ = await reg.dispatch("not-a-uuid", "schema_test_tool", {
        "confirm": "yes",
    })
    payload = json.loads(raw)

    assert payload["schema_hints"] == [
        "confirm 必须是 boolean：使用 true 或 false，不要加引号。",
    ]


def test_note_schema_recovery_explains_flat_block_shape():
    schema = {"type": "array", "items": _BLOCK_ITEM_SCHEMA}
    validator = build_validator(schema)
    issues = validate_input(validator, [{
        "type": "task_list",
        "items": [{"checked": True, "content": [{"content": []}]}],
    }])

    payload = invalid_input_payload("note_create", issues, schema={"properties": {"blocks": schema}})

    assert "重建完整 blocks" in payload["next_action"]
    assert any("扁平项" in hint for hint in payload["schema_hints"])
    assert any("item" in hint for hint in payload["schema_hints"])


def test_note_block_schema_rejects_unknown_wrapper_fields():
    validator = build_validator({"type": "array", "items": _BLOCK_ITEM_SCHEMA})
    issues = validate_input(validator, [{"type": "paragraph", "item": []}])

    assert issues[0]["rule"] == "additionalProperties"


def test_project_colors_use_semantic_tokens_at_agent_boundary():
    from agent.tools import registry

    create_schema = registry.get("create_project").input_schema
    set_color_schema = registry.get("set_color").input_schema
    assert create_schema["properties"]["color"]["enum"] == list(PROJECT_COLOR_KEYS)
    assert set_color_schema["properties"]["color"]["enum"] == list(PROJECT_COLOR_KEYS)
    assert project_color_value("lavender") == PROJECT_COLOR_PRESETS[5]
    assert project_color_key(PROJECT_COLOR_PRESETS[5]) == "lavender"


def test_schema_normalization_converts_numeric_text_and_omits_optional_empty_values():
    normalized, adaptations = normalize_input_by_schema({
        "type": "object",
        "properties": {
            "limit": {"type": "integer"},
            "temperature": {"type": "number"},
            "include_content": {"type": "boolean"},
            "offset": {"type": "integer"},
        },
    }, {"limit": "20", "temperature": "0.7", "include_content": "TRUE", "offset": "  "})

    assert normalized == {"limit": 20, "temperature": 0.7, "include_content": True}
    assert adaptations == [
        "limit:string_to_integer",
        "temperature:string_to_number",
        "include_content:string_to_boolean",
        "offset:empty_omitted",
    ]


def test_schema_normalization_does_not_guess_required_empty_numbers():
    schema = {
        "type": "object",
        "properties": {
            "limit": {"type": "integer"},
            "include_content": {"type": "boolean"},
            "types": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["limit"],
    }
    normalized, adaptations = normalize_input_by_schema(
        schema, {"limit": "", "include_content": "", "types": {"item": ["project", "file"]}}
    )

    # 空值仍不猜（必填空串原样保留、可选空串剔除）；但 {item: [...]} 单键包装
    # 是模型侧稳定的结构性序列化，属于无歧义转换，见 test_item_wrapper_* 用例。
    assert normalized == {"limit": "", "types": ["project", "file"]}
    assert adaptations == ["include_content:empty_omitted", "types:item_wrapper_unwrapped"]


async def test_dispatch_applies_schema_normalization_before_handler():
    seen = None

    async def handler(db, user_id, args):
        nonlocal seen
        seen = dict(args)
        return {"ok": True}

    reg, _ = _make_registry({
        "type": "object",
        "properties": {
            "limit": {"type": "integer"},
            "include_content": {"type": "boolean"},
        },
    }, handler)
    raw, _ = await reg.dispatch(
        "not-a-uuid", "schema_test_tool",
        {"limit": "20", "include_content": "true"},
    )

    assert json.loads(raw)["ok"] is True
    assert seen == {"limit": 20, "include_content": True}


async def test_dispatch_keeps_required_empty_number_invalid():
    reg, _ = _make_registry({
        "type": "object",
        "properties": {"limit": {"type": "integer"}},
        "required": ["limit"],
    })
    raw, _ = await reg.dispatch("not-a-uuid", "schema_test_tool", {"limit": ""})

    payload = json.loads(raw)
    assert payload["error"] == "tool_input_invalid"
    assert payload["issues"][0]["path"] == "limit"


async def test_additional_properties_default_allowed(db, user_a):
    reg, _ = _make_registry({
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    })

    raw, _ = await reg.dispatch(
        user_a.id, "schema_test_tool", {"query": "hello", "future_field": "still allowed"}
    )
    payload = json.loads(raw)

    assert payload["ok"] is True
    assert payload["args"]["future_field"] == "still allowed"


async def test_dispatch_commits_successful_task_transaction(db, user_a):
    async def handler(db, user_id, args):
        project = Project(user_id=user_id, name="事务提交测试")
        db.add(project)
        await db.flush()
        return {"project_id": project.id}

    reg, _ = _make_registry({"type": "object"}, handler)
    raw, _ = await reg.dispatch(user_a.id, "schema_test_tool", {})
    project_id = json.loads(raw)["project_id"]

    persisted = await db.scalar(select(Project).where(Project.id == project_id))
    assert persisted is not None


async def test_dispatch_enriches_business_error_with_usage_contract():
    async def handler(db, user_id, args):
        return {"error": "资源不存在", "resource": "project"}

    reg, _ = _make_registry({"type": "object"}, handler)
    raw, _ = await reg.dispatch("not-a-uuid", "schema_test_tool", {})
    payload = json.loads(raw)

    assert payload["error"] == "资源不存在"
    assert payload["resource"] == "project"
    assert payload["tool"] == "schema_test_tool"
    assert payload["usage_hint"]
    assert payload["next_action"]


async def test_dispatch_rolls_back_failed_task_transaction(db, user_a):
    async def handler(db, user_id, args):
        db.add(Project(user_id=user_id, name="事务回滚测试"))
        await db.flush()
        raise RuntimeError("测试事务失败")

    reg, _ = _make_registry({"type": "object"}, handler)
    raw, _ = await reg.dispatch(user_a.id, "schema_test_tool", {})

    assert json.loads(raw)["error"].startswith("工具 schema_test_tool 执行出错")
    persisted = await db.scalar(select(Project).where(Project.name == "事务回滚测试"))
    assert persisted is None


async def test_explicit_additional_properties_false_rejected():
    reg, _ = _make_registry({
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
        "additionalProperties": False,
    })

    raw, _ = await reg.dispatch(
        "not-a-uuid", "schema_test_tool", {"query": "hello", "secret_extra": "do-not-echo"}
    )
    payload = json.loads(raw)

    assert payload["error"] == "tool_input_invalid"
    assert payload["issues"][0]["rule"] == "additionalProperties"
    assert "do-not-echo" not in raw


@pytest.mark.parametrize("raw_id", ["91", "#91"])
async def test_existing_integer_id_normalization_runs_before_schema(db, user_a, raw_id):
    seen = None

    async def handler(db, user_id, args):
        nonlocal seen
        seen = dict(args)
        return {"ok": True}

    reg, _ = _make_registry({
        "type": "object",
        "properties": {"project_id": {"type": "integer"}},
        "required": ["project_id"],
    }, handler)

    raw, _ = await reg.dispatch(user_a.id, "schema_test_tool", {"project_id": raw_id})

    assert json.loads(raw)["ok"] is True
    assert seen == {"project_id": 91}


async def test_mutating_tool_invalid_input_never_runs_handler():
    called = False

    async def handler(db, user_id, args):
        nonlocal called
        called = True
        return {"success": True}

    reg, _ = _make_registry({
        "type": "object",
        "properties": {"project_id": {"type": "integer"}},
        "required": ["project_id"],
    }, handler, mutates=True)

    raw, _ = await reg.dispatch("not-a-uuid", "schema_test_tool", {"project_id": "not-an-id"})

    assert json.loads(raw)["error"] == "tool_input_invalid"
    assert called is False


def test_invalid_json_schema_fails_fast_at_registration():
    reg = SkillRegistry()
    tool = Tool(
        name="bad_schema_tool",
        description="bad schema",
        input_schema={"type": "object", "required": "query"},
        handler=_ok_handler,
    )

    with pytest.raises(ToolContractError, match="JSON Schema Draft 2020-12"):
        reg.add(tool)


def test_validator_is_cached_without_changing_provider_schemas():
    schema = {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    }
    reg, tool = _make_registry(schema)

    assert tool._input_validator is not None
    assert tool.to_anthropic()["input_schema"] == schema
    assert tool.to_openai()["function"]["parameters"] == schema
    assert reg.get("schema_test_tool") is tool


def test_provider_schema_parity_uses_one_tool_contract():
    schema = {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    }
    reg, tool = _make_registry(schema)
    anthropic = reg.anthropic_schemas([tool.name])[0]
    openai = reg.openai_schemas([tool.name])[0]

    assert anthropic["name"] == openai["function"]["name"] == tool.name
    assert anthropic["description"] == openai["function"]["description"] == tool.description_short
    assert anthropic["input_schema"] == openai["function"]["parameters"] == schema


def test_provider_schema_serialization_does_not_run_compactor(monkeypatch):
    schema = {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    }
    _, tool = _make_registry(schema)

    def fail_compactor(_value):
        raise AssertionError("provider serialization must use source schema directly")

    monkeypatch.setattr(tool_base, "_compact_schema", fail_compactor)
    assert tool.to_anthropic()["input_schema"] == schema
    assert tool.to_openai()["function"]["parameters"] == schema


def test_all_registered_tools_have_cached_validators():
    # importing agent.tools.base 已经执行 agent.tools 包初始化并注册全部领域工具；
    # 这条测试相当于全量 schema inventory：任一历史 schema 非法会在 import/注册时先 fail-fast。
    assert global_registry._tools
    assert all(tool._input_validator is not None for tool in global_registry._tools.values())


def test_item_wrapper_arrays_are_unwrapped_before_validation():
    """MiniMax 等模型把数组稳定序列化成 {"item": [...]}（内层 content/items 也包），
    schema_hints 提示重试也改不掉。包装是结构性的：schema 期望 array 且键名固定，
    归一化层解除包装后必须原样通过校验。"""
    schema = {
        "type": "object",
        "properties": {
            "append_blocks": {"type": "array", "items": _BLOCK_ITEM_SCHEMA},
        },
        "required": ["append_blocks"],
    }
    raw = {
        "append_blocks": {"item": [
            {"type": "heading", "content": {"item": {"type": "text", "text": "到货验收"}}},
            {"type": "bullet_list", "items": {"item": [
                {"content": {"item": {"type": "text", "text": "9/3 晚上收到寄回的耳机"}}},
            ]}},
        ]},
    }

    args, adaptations = normalize_input_by_schema(schema, raw)
    issues = validate_input(build_validator(schema), args)

    assert issues == []
    blocks = args["append_blocks"]
    assert blocks[0]["content"][0]["text"] == "到货验收"
    assert blocks[1]["items"][0]["content"][0]["text"] == "9/3 晚上收到寄回的耳机"
    assert len([a for a in adaptations if a.endswith("item_wrapper_unwrapped")]) == 4


def test_item_wrapper_unwrap_does_not_touch_plain_objects():
    """单键对象只在 schema 期望 array 的位置解除；object 字段和多个键的对象不动。"""
    schema = {
        "type": "object",
        "properties": {
            "options": {"type": "object", "properties": {"item": {"type": "string"}}},
            "weird": {"type": "array", "items": {"type": "string"}},
        },
    }
    raw = {"options": {"item": "keep"}, "weird": {"other": ["x"], "item": ["y"]}}

    args, adaptations = normalize_input_by_schema(schema, raw)

    assert args["options"] == {"item": "keep"}
    assert args["weird"] == {"other": ["x"], "item": ["y"]}
    assert adaptations == []
