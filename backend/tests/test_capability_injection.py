from types import SimpleNamespace

import pytest

from agent.capabilities.injector import catalog_block
from agent.capabilities.models import CapabilityMeta, CapabilitySnapshot
from agent.core import LLMRunner, _loaded_skill_slugs
from agent.tools.meta import _use_skill
from agent.capabilities.diagnostics import capability_injection_diagnostics
from agent.runtime.loopscope_trace.hooks import _skill_result_metadata
from agent.runtime.loopscope_trace.hooks import _tool_names_from_schemas


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
    assert "declare_tools" in block


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


def test_emergency_switch_keeps_full_schema_path_when_injection_is_enabled():
    from agent.runner import _capability_context

    settings = SimpleNamespace(agent=SimpleNamespace(
        capability_injection_enabled=True,
        capability_force_full_schema=True,
    ))
    assert _capability_context(["web_search"], settings) is None


def test_loaded_skill_is_detected_from_history_and_can_be_reloaded_after_compaction():
    messages = [{
        "role": "tool",
        "content": '{"skill":"weather","content":"天气技能正文","_capability_usage":{"kind":"skill","slug":"weather","loaded":true}}',
    }]
    assert _loaded_skill_slugs(messages) == {"weather"}
    assert _loaded_skill_slugs([]) == set()


@pytest.mark.anyio
async def test_use_skill_result_contains_structured_usage_marker():
    result = await _use_skill(None, None, {"name": "weather"})
    assert result["_capability_usage"] == {
        "kind": "skill", "slug": "weather", "loaded": True,
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


def test_capability_context_starts_with_declaration_and_refreshes_schema_selection():
    from agent.capabilities.injector import CapabilityToolContext
    from agent.capabilities.selector import RegistryCapabilitySelector

    snapshot = CapabilitySnapshot(
        generation=1,
        tools={
            "declare_tools": CapabilityMeta("declare_tools", "tool", "声明工具。"),
            "image_search": CapabilityMeta("image_search", "tool", "搜索图片。"),
        },
        skills={},
    )
    context = CapabilityToolContext(
        snapshot, RegistryCapabilitySelector(), declaration_enabled=True,
    )
    assert context.select_for_messages([]).tool_names == ("declare_tools",)
    assert context.declare(["image_search", "not_authorized"]) == ("image_search",)
    assert context.select_for_messages([]).tool_names == ("declare_tools", "image_search")
