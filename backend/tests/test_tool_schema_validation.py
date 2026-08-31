"""工具调用 JSON Schema 契约回归。

验证边界在 SkillRegistry.dispatch：合法 JSON 但 schema 不合法时必须在 DB/handler 前拒绝，
并保留既有的整数 ID 弱归一化。错误结果不能回显实际非法值。
"""
import json

import pytest
from sqlalchemy import select

from app.models import Project

import agent.tools.base as tool_base
from agent.tools.base import SkillRegistry, Tool, ToolContractError, registry as global_registry
from agent.tools.tool_contract import normalize_input_by_schema


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

    raw, _ = await reg.dispatch("not-a-uuid", "schema_test_tool", {
        "channels": {"item": "qq"},
    })
    payload = json.loads(raw)

    assert payload["schema_hints"] == [
        'channels 必须是数组，例如 ["web"]；不要传对象。',
    ]
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


def test_schema_normalization_does_not_guess_required_empty_numbers_or_array_shapes():
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

    assert normalized == {"limit": "", "types": {"item": ["project", "file"]}}
    assert adaptations == ["include_content:empty_omitted"]


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
