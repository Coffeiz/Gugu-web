"""MCP1-002 验收：schema 消毒、命名前缀、Tool 包装、拒载。"""
from agent.mcp.models import McpToolMeta
from agent.mcp.schema_adapter import (
    build_mcp_tool,
    description_short_of,
    prefixed_tool_name,
    sanitize_input_schema,
    validate_input_schema,
)


def test_prefix_and_rejects_illegal_names():
    assert prefixed_tool_name("weather", "get_forecast") == "mcp_weather_get_forecast"
    # 工具名含非法字符 → 拒载（返回 None）
    assert prefixed_tool_name("weather", "get-forecast") is None
    assert prefixed_tool_name("weather", "a b") is None
    assert prefixed_tool_name("weather", "") is None
    # server 名非法字符降级为下划线
    assert prefixed_tool_name("my server", "go") == "mcp_my_server_go"
    # 超长拒载
    assert prefixed_tool_name("s", "t" * 70) is None


def test_sanitize_passes_through_plain_schema():
    schema = {
        "type": "object",
        "properties": {"city": {"type": "string", "description": "城市"}},
        "required": ["city"],
    }
    assert sanitize_input_schema(schema) == {
        "type": "object",
        "properties": {"city": {"type": "string", "description": "城市"}},
        "required": ["city"],
    }


def test_sanitize_inlines_local_ref():
    schema = {
        "type": "object",
        "$defs": {"addr": {"type": "object", "properties": {"city": {"type": "string"}}}},
        "properties": {"home": {"$ref": "#/$defs/addr"}},
    }
    out = sanitize_input_schema(schema)
    assert out["properties"]["home"]["type"] == "object"
    assert "city" in out["properties"]["home"]["properties"]
    assert "$defs" not in out


def test_sanitize_cyclic_ref_degrades_to_string():
    schema = {
        "type": "object",
        "$defs": {"node": {"type": "object", "properties": {"child": {"$ref": "#/$defs/node"}}}},
        "properties": {"root": {"$ref": "#/$defs/node"}},
    }
    out = sanitize_input_schema(schema)
    # 展开一层后遇到环引用 → 降级为 string，不死循环
    child = out["properties"]["root"]["properties"]["child"]
    assert child["type"] == "string"


def test_sanitize_oneof_picks_first_non_null_branch():
    schema = {
        "type": "object",
        "properties": {
            "target": {
                "oneOf": [
                    {"type": "null"},
                    {"type": "object", "properties": {"id": {"type": "string"}}},
                    {"type": "string"},
                ]
            }
        },
    }
    out = sanitize_input_schema(schema)
    assert out["properties"]["target"]["type"] == "object"
    assert "oneOf" not in out["properties"]["target"]


def test_sanitize_allof_merges_properties():
    schema = {
        "type": "object",
        "properties": {
            "thing": {
                "allOf": [
                    {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]},
                    {"type": "object", "properties": {"b": {"type": "integer"}}, "required": ["b"]},
                ]
            }
        },
    }
    out = sanitize_input_schema(schema)
    thing = out["properties"]["thing"]
    assert set(thing["properties"]) == {"a", "b"}
    assert sorted(thing["required"]) == ["a", "b"]
    assert "allOf" not in thing


def test_sanitize_drops_unknown_keys_and_deep_nesting_degrades():
    schema = {
        "type": "object",
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "properties": {
            "odd": {"type": "string", "discriminator": {"x": 1}},
            "deep": _nest_depth(12),
        },
    }
    out = sanitize_input_schema(schema)
    assert "discriminator" not in out["properties"]["odd"]
    # 超深层级被降级为 string（沿链路数 8 层后）
    assert "type" in out["properties"]["deep"]


def _nest_depth(levels: int) -> dict:
    node: dict = {"type": "string"}
    for _ in range(levels):
        node = {"type": "object", "properties": {"inner": node}}
    return node


def test_validate_input_schema_rejects_non_object_top():
    assert validate_input_schema({"type": "string"}) is not None
    assert validate_input_schema("nope") is not None
    assert validate_input_schema({"type": "object", "properties": {}}) is None


def test_build_mcp_tool_wraps_with_contract_defaults():
    meta = McpToolMeta(
        server_id="00000000-0000-0000-0000-000000000001",
        server_name="weather",
        tool_name="get_forecast",
        prefixed_name="mcp_weather_get_forecast",
        description_short="查询天气预报",
        input_schema={"type": "object", "properties": {"city": {"type": "string"}}},
    )

    async def handler(db, user_id, args):
        return {"ok": True}

    tool = build_mcp_tool(meta, handler)
    assert tool.source == "mcp"
    assert tool.mutates is True
    assert tool.repeat_safe is False
    assert tool.requires_confirmation is False
    assert tool.input_schema["type"] == "object"
    assert tool.name == "mcp_weather_get_forecast"
    # schema_version/label 等 registry 契约字段可正常使用
    assert tool.label == "[weather] get_forecast"


def test_description_short_first_line_truncated():
    assert description_short_of("第一行说明\n第二行") == "第一行说明"
    long = "长" * 250
    assert len(description_short_of(long)) == 100
    assert description_short_of(None) == ""
