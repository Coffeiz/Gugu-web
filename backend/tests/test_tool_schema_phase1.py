"""PRD-LLM-16 Phase 1：高风险工具的来源、定位和动作约束。"""

import pytest

from agent.tools import registry
from agent.tools.base import _compact_schema
from agent.tools.tool_contract import build_validator, normalize_legacy_input, validate_input


def _issues(name: str, payload: dict) -> list[dict]:
    tool = registry.get(name)
    return validate_input(build_validator(tool.input_schema), payload)


@pytest.mark.parametrize(
    ("name", "valid", "invalid"),
    [
        ("copy_file", {"file_id": 1}, {}),
        ("send_file", {"file_id": 1}, {}),
        ("add_event_reminder", {"event_id": 1}, {}),
    ],
)
def test_phase1_requires_a_single_source_or_event(name, valid, invalid):
    assert _issues(name, valid) == []
    assert _issues(name, invalid)


def test_send_file_rejects_multiple_sources_and_orphan_title():
    assert _issues("send_file", {"file_id": 1, "url": "https://example.com/a.png"})
    assert _issues("send_file", {"title": "图片"})
    assert _issues("send_file", {"url": "https://example.com/a.png", "title": "图片"}) == []


def test_add_event_reminder_rejects_ambiguous_reminder_inputs():
    assert _issues("add_event_reminder", {"event_id": 1, "reminders": [30], "lead_minutes": 60})
    assert _issues("add_event_reminder", {"event": "评审", "lead_minutes": 60}) == []


def test_update_todo_action_has_conditional_fields_and_legacy_compatibility():
    assert _issues("update_todo", {"todo": "文档", "action": "complete", "done": True}) == []
    assert _issues("update_todo", {"todo": "文档", "action": "rename", "text": "完整文档"}) == []
    assert _issues("update_todo", {"todo": "文档", "action": "move", "to_stage": "进行中"}) == []
    assert _issues("update_todo", {"todo": "文档", "action": "complete"})
    assert _issues("update_todo", {"todo": "文档", "action": "complete", "done": True, "text": "混合动作"})
    assert _issues("update_todo", {"todo": "文档", "done": True}) == []
    assert _issues("update_todo", {"todo": "文档"})


def test_search_conversations_keeps_recent_without_search_term():
    assert _issues("search_conversations", {}) == []
    assert _issues("search_conversations", {"query": "文件架构"}) == []
    assert _issues("search_conversations", {"query": "文件架构", "keyword": "架构"})


def test_phase2_calendar_and_file_semantics():
    assert _issues("create_event", {"title": "评审", "date": "2026-09-03", "all_day": True}) == []
    assert _issues("create_event", {"title": "评审", "date": "2026-09-03", "all_day": True, "time": "14:30"})
    assert _issues("create_event", {"title": "评审", "date": "2026-09-03", "all_day": False})
    assert _issues("create_event", {"title": "评审", "date": "2026-09-03", "all_day": False, "time": "14:30"}) == []
    assert _issues("update_event", {"event_id": 1, "all_day": True}) == []
    assert _issues("update_event", {"event_id": 1, "all_day": False})
    assert _issues("copy_file", {"file_id": 1, "destination": "folder"})
    assert _issues("copy_file", {"file_id": 1, "destination": "same"}) == []
    assert _issues("send_file", {"source_type": "url", "url": "https://example.com/a.png"}) == []
    assert _issues("send_file", {"source_type": "url", "file_id": 1})
    assert _issues("save_uploaded_file", {"source": "latest"}) == []
    assert _issues("save_uploaded_file", {"source": "attach_id"})


def test_phase3_project_requires_explicit_date_range():
    assert _issues("create_project", {
        "name": "项目",
        "start_date": "2026-08-29",
        "deadline": "2026-09-05",
    }) == []
    assert _issues("create_project", {"name": "项目"})


def test_phase8_migrated_tools_are_source_canonical_schema():
    for name in (
        "create_project", "create_event", "update_event", "save_uploaded_file", "note_create",
        "list_events", "list_projects", "list_event_reminders", "remove_event_reminder",
        "list_folders", "add_todo", "remove_todo", "set_stages", "read_file",
        "note_get", "note_update", "note_delete", "note_restore",
        "get_project", "read_conversation", "bind_web_session",
        "add_stage", "get_workspace", "get_upcoming", "create_client",
        "global_search", "canvas_search", "canvas_search_placeable",
        "copy_file", "delete_file", "send_file",
        "update_workspace",
        "update_client", "create_workspace", "react",
        "canvas_create_note", "canvas_update_note", "canvas_batch",
        "create_document",
        "update_stage", "rename_file", "edit_file", "search_memory", "save_knowledge", "remember",
        "image_search", "inspect_images", "move_items", "archive_project", "use_skill", "call_tool",
    ):
        tool = registry.get(name)
        assert tool.input_schema == _compact_schema(tool.input_schema), name


def test_phase8_compactor_keeps_reserved_parameter_names():
    schema = {"type": "object", "properties": {
        "title": {"type": "string"},
        "description": {"type": "string"},
    }}
    assert _compact_schema(schema) == schema


def test_phase8_date_and_time_constraints_are_structural():
    assert _issues("create_project", {
        "name": "项目", "start_date": "2026-08-29", "deadline": "2026-09-05",
    }) == []
    assert _issues("create_project", {
        "name": "项目", "start_date": "2026/08/29", "deadline": "2026-09-05",
    })
    assert _issues("create_event", {
        "title": "评审", "date": "2026-09-03", "all_day": False, "time": "14:30",
    }) == []
    assert _issues("create_event", {
        "title": "评审", "date": "2026-09-03", "all_day": False, "time": "2:30 PM",
    })


def test_phase8_workspace_binding_is_structural():
    assert _issues("create_workspace", {
        "name": "项目工作区", "kind": "project", "project_id": 1,
    }) == []
    assert _issues("create_workspace", {
        "name": "文件夹工作区", "kind": "folder", "folder_id": 2,
    }) == []
    assert _issues("create_workspace", {
        "name": "错误工作区", "kind": "project", "folder_id": 2,
    })
    assert _issues("create_workspace", {
        "name": "错误工作区", "kind": "folder", "project_id": 1,
    })


def test_phase8_document_project_location_is_structural():
    base = {"name": "说明", "format": "md", "content": "正文"}
    assert _issues("create_document", base) == []
    assert _issues("create_document", {**base, "space": "project"})
    assert _issues("create_document", {**base, "space": "project", "project_id": 1}) == []


def test_phase8_edit_modes_are_structural():
    assert _issues("edit_file", {
        "file_id": 1, "mode": "replace_all", "content": "新内容",
    }) == []
    assert _issues("edit_file", {
        "file_id": 1, "mode": "append", "content": "追加内容",
    }) == []
    assert _issues("edit_file", {
        "file_id": 1, "mode": "find_replace", "find": "旧", "replace": "新",
    }) == []
    assert _issues("edit_file", {"file_id": 1, "mode": "replace_all"})
    assert _issues("edit_file", {"file_id": 1, "mode": "append", "find": "旧", "replace": "新"})
    assert _issues("edit_file", {"file_id": 1, "mode": "find_replace", "content": "新内容"})


def test_phase3_legacy_event_adapter_is_explicit_and_value_preserving():
    normalized, adaptations = normalize_legacy_input("create_event", {
        "title": "评审", "date": "2026-09-03", "time": "14:30",
    })
    assert normalized["all_day"] is False
    assert adaptations == ["create_event.all_day_inferred"]

    normalized, adaptations = normalize_legacy_input("create_project", {"name": "项目"})
    assert normalized == {"name": "项目"}
    assert adaptations == []


def test_phase4_schema_errors_are_aggregated_without_argument_values(monkeypatch):
    from agent.runtime.loopscope_trace import state

    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = state._ScopeRun(
        id="run-schema-aggregate", trace_id="trace-schema-aggregate",
        session_key="gugu:web:test", external_session_id="test",
        source="web", started_at=state._now(),
    )
    state.record_tool_schema_error(
        run, tool_name="create_event", schema={"type": "object"},
        error={"issues": [{"path": "all_day", "rule": "required"}]},
        error_kind="validation_error", arguments_shape={"title": "string"},
    )
    aggregate = run.attributes["tool_schema_errors"]
    assert aggregate["count"] == 1
    assert aggregate["by_tool"] == {"create_event": 1}
    assert aggregate["by_field_path"] == {"all_day": 1}
    assert aggregate["by_provider"] == {"unknown": 1}
