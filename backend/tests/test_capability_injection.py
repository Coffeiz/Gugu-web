from types import SimpleNamespace

import pytest

from agent.capabilities.injector import catalog_block
from agent.capabilities.models import CapabilityMeta, CapabilitySnapshot
from agent.core import LLMRunner, _loaded_skill_slugs, _resolve_adapter_arguments
from agent.skills import skill_content_digest
from agent.tools.meta import _use_skill
from agent.capabilities.diagnostics import capability_injection_diagnostics
from agent.runtime.loopscope_trace.hooks import _skill_result_metadata
from agent.runtime.loopscope_trace.hooks import _tool_names_from_schemas
from agent.tools.tool_contract import invalid_input_payload


def test_catalog_contains_short_descriptions_only():
    snapshot = CapabilitySnapshot(
        generation=1,
        tools={"search": CapabilityMeta("search", "tool", "搜索资料。", "search")},
        skills={"web": CapabilityMeta("web", "skill", "联网查找资料。", "search")},
    )
    block = catalog_block(snapshot)
    assert "搜索资料" in block
    assert "联网查找资料" in block
    assert "input_schema" not in block
    assert "call_tool" in block
    assert "get_tool_schema" in block
    assert "简介中的字段列表不完整" in block
    assert "实际调用前必须确认历史里有当前版本的完整 Schema" in block
    assert "权限和执行校验由代码完成" in block


def test_catalog_rejects_long_description_instead_of_truncating():
    snapshot = CapabilitySnapshot(
        generation=1,
        tools={"search": CapabilityMeta(
            "search", "tool", "x" * 101
        )},
        skills={},
    )
    with pytest.raises(ValueError, match="超过 100 字符"):
        catalog_block(snapshot)


def test_fixed_adapter_preserves_nested_and_flattened_business_arguments():
    assert _resolve_adapter_arguments({
        "name": "http_get",
        "arguments": {"url": "https://example.com"},
    }) == {"url": "https://example.com"}
    assert _resolve_adapter_arguments({
        "name": "http_get",
        "url": "https://example.com",
    }) == {"url": "https://example.com"}
    assert _resolve_adapter_arguments({"name": "http_get"}) == {}


def test_capability_diagnostics_are_redacted_to_metrics():
    snapshot = CapabilitySnapshot(
        generation=3,
        tools={"search": CapabilityMeta("search", "tool", "搜索资料。", "search")},
        skills={},
    )
    from agent.capabilities.injector import CapabilityToolContext
    from agent.capabilities.selector import RegistryCapabilitySelector

    context = CapabilityToolContext(snapshot, RegistryCapabilitySelector())
    result = capability_injection_diagnostics(context)
    assert result["catalog_count"] == 1
    assert result["selected_tool_count"] == 1
    assert "搜索资料" not in repr(result)
    assert "input_schema" not in repr(result)


def test_capability_diagnostics_expose_tool_and_skill_injection_without_schema():
    snapshot = CapabilitySnapshot(
        generation=4,
        tools={"search": CapabilityMeta("search", "tool", "搜索资料。")},
        skills={"web": CapabilityMeta("web", "skill", "联网查找资料。")},
    )
    from agent.capabilities.injector import CapabilityToolContext
    from agent.capabilities.selector import RegistryCapabilitySelector

    result = capability_injection_diagnostics(
        CapabilityToolContext(snapshot, RegistryCapabilitySelector())
    )
    assert result["selected_tool_names"] == ["search"]
    assert result["skill_names"] == ["web"]
    assert result["skill_count"] == 1
    assert "input_schema" not in repr(result)


def test_llm_runner_accepts_dynamic_capability_context_without_changing_default_api():
    runner = LLMRunner([], SimpleNamespace(ai=SimpleNamespace(provider="openai")))
    assert runner.capability_context is None


def test_loaded_skill_is_detected_from_history_and_can_be_reloaded_after_compaction():
    digest = skill_content_digest("weather")
    messages = [{
        "role": "tool",
        "content": '{"skill":"weather","content":"天气技能正文","_capability_usage":{"kind":"skill","slug":"weather","loaded":true,"content_digest":"%s"}}' % digest,
    }]
    assert _loaded_skill_slugs(messages) == {"weather": digest}
    assert _loaded_skill_slugs([{
        "role": "tool",
        "content": '{"_capability_usage":{"kind":"skill","slug":"weather","loaded":true}}',
    }]) == {}
    assert _loaded_skill_slugs([]) == {}


@pytest.mark.anyio
async def test_use_skill_result_contains_structured_usage_marker():
    result = await _use_skill(None, None, {"name": "weather"})
    assert result["_capability_usage"] == {
        "kind": "skill", "slug": "weather", "loaded": True,
        "content_digest": skill_content_digest("weather"),
    }


def test_skill_trace_metadata_does_not_copy_skill_body():
    metadata = _skill_result_metadata({"skill": "weather", "content": "技能正文"})
    assert metadata["skill"] == "weather"
    assert metadata["content_chars"] == 4
    assert "技能正文" not in repr(metadata)
    assert metadata["content_digest"]


def test_loopscope_tool_schema_names_fall_back_to_provider_payload():
    assert _tool_names_from_schemas([
        {"type": "function", "function": {"name": "ask_user"}},
        {"name": "image_search"},
        {"type": "function", "function": {"name": "ask_user"}},
    ]) == ["ask_user", "image_search"]


def test_fixed_adapter_context_only_exposes_stable_provider_tools():
    from agent.capabilities.injector import build_fixed_adapter_context

    context = build_fixed_adapter_context(["image_search"])
    assert context.fixed_adapter is True
    assert context.select_for_messages([]).tool_names == ("call_tool", "get_tool_schema", "use_skill", "ask_user")


def test_invalid_tool_input_requests_schema_recovery():
    payload = invalid_input_payload("create_note", [{
        "path": "blocks", "rule": "type", "message": "字段类型应为 array",
    }])
    assert payload["_schema_recovery"] == {"needed": True, "reason": "validation_error"}
