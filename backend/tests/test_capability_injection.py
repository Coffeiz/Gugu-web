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
from agent.tools.tool_contract import invalid_input_payload, invalid_tool_call_payload, normalize_tool_name


def test_catalog_contains_short_descriptions_only():
    snapshot = CapabilitySnapshot(
        generation=1,
        tools={"search": CapabilityMeta("search", "tool", "搜索资料。", "search")},
        skills={"web": CapabilityMeta("web", "skill", "联网查找资料。", "search")},
    )
    block = catalog_block(snapshot, include_builtin_skills=True)
    assert "搜索资料" in block
    assert "联网查找资料" in block
    assert "### 工具" in block
    assert "### Skill" in block
    assert block.index("### 工具") < block.index("### Skill")
    assert "input_schema" not in block
    assert "call_tool" in block
    assert "get_tool_schema" in block
    assert "紧凑字段签名" in block
    assert "字段签名只展示类型、简单枚举、必填状态和一层结构" in block
    assert "权限和执行校验由代码完成" in block


def test_catalog_omits_builtin_skill_already_present_in_static_prompt():
    snapshot = CapabilitySnapshot(
        generation=1,
        tools={"search": CapabilityMeta("search", "tool", "搜索资料。")},
        skills={"web": CapabilityMeta("web", "skill", "联网查找资料。")},
    )

    block = catalog_block(snapshot)

    assert "### 工具" in block
    assert "### Skill" not in block
    assert "联网查找资料" not in block


def test_catalog_keeps_user_skill_in_separate_skill_section():
    snapshot = CapabilitySnapshot(
        generation=1,
        tools={"search": CapabilityMeta("search", "tool", "搜索资料。")},
        skills={"user-skill": CapabilityMeta(
            "user-skill", "skill", "用户定义的做法。", source="user"
        )},
    )

    block = catalog_block(snapshot)

    assert "### 工具" in block
    assert "### Skill" in block
    assert "用户定义的做法" in block


def test_catalog_derives_compact_field_signature_from_tool_registry():
    snapshot = CapabilitySnapshot(
        generation=1,
        tools={"list_files": CapabilityMeta("list_files", "tool", "列出文件。")},
        skills={},
    )
    block = catalog_block(snapshot)
    assert "list_files" in block
    assert "limit(integer" in block
    assert "例如" not in block
    assert "input_schema" not in block


def test_catalog_exposes_nested_note_content_shape_without_full_schema():
    snapshot = CapabilitySnapshot(
        generation=1,
        tools={"note_create": CapabilityMeta("note_create", "tool", "记录笔记。")},
        skills={},
    )
    block = catalog_block(snapshot)
    assert "blocks(array<object:type:string[paragraph|heading|bullet_list|ordered_list|task_list|blockquote|code_block|horizontal_rule],content:array<object:type:string[text|reference]" in block
    assert "input_schema" not in block


def test_catalog_routes_user_skill_creation_to_create_skill():
    snapshot = CapabilitySnapshot(
        generation=1,
        tools={"create_skill": CapabilityMeta(
            "create_skill", "tool", "创建用户自定义技能；保存可复用做法。", "meta"
        )},
        skills={},
    )
    block = catalog_block(snapshot)
    assert "创建用户自定义技能" in block
    assert "创建技能误当成 `create_project`" in block
    assert "related_tools 使用空数组 []" in block


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


def test_invalid_tool_call_payload_supports_required_arguments():
    payload = invalid_tool_call_payload(
        path="arguments", rule="required", reason="call_tool.arguments 是必填字段"
    )
    assert payload["issues"] == [{
        "path": "arguments", "rule": "required", "message": "call_tool.arguments 是必填字段",
    }]
    assert "完整 Schema" in payload["next_action"]


def test_tool_name_protocol_does_not_stringify_business_objects():
    """错误的 name 对象必须停在协议校验，不得变成一个伪工具名。"""
    assert normalize_tool_name("  canvas_create  ") == "canvas_create"
    assert normalize_tool_name({"canvas_id": 161, "relation_id": 837}) is None
    assert normalize_tool_name(["canvas_create"]) is None
    payload = invalid_tool_call_payload(reason="call_tool.name 必须是字符串")
    assert payload["error"] == "tool_call_invalid"
    assert payload["issues"] == [{
        "path": "name", "rule": "type", "message": "call_tool.name 必须是字符串"
    }]
    assert "canvas_id" not in str(payload)


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


def test_fixed_adapter_snapshot_can_persist_all_authorized_tool_signatures():
    from agent.capabilities.injector import build_fixed_adapter_context

    context = build_fixed_adapter_context(["image_search"])
    block = catalog_block(context.snapshot, tool_order=context.snapshot.tools)
    assert "image_search" in block
    assert "字段：" in block
    assert "call_tool" in block


def test_invalid_tool_input_requests_schema_recovery():
    payload = invalid_input_payload("note_create", [{
        "path": "blocks", "rule": "type", "message": "字段类型应为 array",
    }])
    assert payload["_schema_recovery"] == {"needed": True, "reason": "validation_error"}


def test_scheduled_tasks_skill_documents_channel_array_shape():
    from agent.skills import load_skill

    content = load_skill("scheduled-tasks")
    assert content is not None
    assert 'channels=["qq"]' in content
    assert 'channels={"item":"qq"}' in content
    assert "不修改的字段直接省略" in content


def test_scheduled_tasks_skill_routes_calendar_reminders_to_event():
    from agent.skills import load_skill

    content = load_skill("scheduled-tasks")
    assert content is not None
    assert "create_event" in content
    assert "add_event_reminder" in content
    assert "不要再调用 `create_scheduled_task`" in content
    assert "日历事件本身不会主动提醒" not in content


def test_web_search_skill_contains_freshness_verification_protocol():
    from agent.skills import load_skill

    content = load_skill("web-search")
    assert content is not None
    assert "事实准确性与时效核验" in content
    assert "未来事件" in content
    assert "来源发布时间" in content
    assert "事件实际发生时间" in content
