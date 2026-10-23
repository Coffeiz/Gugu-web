"""展示时间线升级保护跨页去重、真实耗时和模型历史隔离。"""
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

from app.db.migrations.chat_timeline import build_chat_tool_events, migrate_session_timeline


def row(id, *, run="run-a", timeline=None, blocks=None, role="assistant", text=""):
    return SimpleNamespace(id=id, run_id=run, round_id="r1", role=role,
        content=text, content_json=blocks, display_timeline=timeline, files=None,
        canonical_batch_id=1, created_at=datetime(2026, 10, 1))


def apply(rows):
    updates = migrate_session_timeline(rows)
    for message in rows:
        if message.id in updates:
            message.display_timeline = updates[message.id]
    return updates


def test_migration_merges_cross_row_duplicates_and_keeps_recorded_duration():
    rows = [row(1, timeline=[{"kind": "tool", "toolCallId": "call-1", "toolStatus": "running"}]),
        row(2, timeline=[{"kind": "tool", "toolCallId": "call-1", "toolStatus": "success", "toolDurationMs": 6500},
                         {"kind": "assistant", "text": "最终回复"}]),
        row(3, blocks=[{"type": "tool_call", "id": "call-1", "name": "call_tool", "arguments": {
            "tool_name": "search_conversations", "arguments": {"query": "合成查询"}}}]),
        row(4, blocks=[{"type": "tool_result", "tool_call_id": "call-1", "content": "查询结果"}], role="tool")]
    canonical = deepcopy([value.content_json for value in rows])
    apply(rows)
    tools = [item for value in rows for item in value.display_timeline or [] if item["kind"] == "tool"]
    assert len(tools) == 1
    assert tools[0] == {"kind": "tool", "toolCallId": "call-1", "toolStatus": "success", "toolDurationMs": 6500,
        "runId": "run-a", "roundId": "r1", "toolName": "search_conversations", "toolLabel": "搜历史对话",
        "toolInput": {"query": "合成查询"}, "toolResult": "查询结果", "timelineOrder": 1001}
    assert [value.content_json for value in rows] == canonical
    assert apply(rows) == {}


def test_canonical_only_tools_move_before_final_reply_without_inventing_duration():
    rows = [row(1, text="最终回复"),
        row(2, blocks=[{"type": "tool_call", "id": "call-1", "name": "read_file", "arguments": {}}]),
        row(3, blocks=[{"type": "tool_result", "tool_call_id": "call-1", "content": "结果"}], role="tool")]
    apply(rows)
    assert [item["kind"] for item in rows[0].display_timeline] == ["tool", "assistant"]
    assert "toolDurationMs" not in rows[0].display_timeline[0]
    assert rows[0].display_timeline[0]["toolStatus"] == "success"
    assert apply(rows) == {}


def test_reused_provider_call_ids_are_isolated_by_run_and_round():
    rows = [row(1, blocks=[{"type": "tool_call", "id": "call-1", "name": "read_file"}]),
        row(2, run="run-b", blocks=[{"type": "tool_call", "id": "call-1", "name": "read_file"}])]
    apply(rows)
    events = [item for value in rows for item in value.display_timeline or []]
    assert len(events) == 2
    assert {item["runId"] for item in events} == {"run-a", "run-b"}
    assert all(item["toolStatus"] == "stopped" for item in events)
    assert apply(rows) == {}


async def test_alembic_upgrade_persists_and_is_idempotent(db, user_a):
    import importlib.util
    from pathlib import Path
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext
    from sqlalchemy import select
    from app.models import ConversationMessage, ConversationSession

    session = ConversationSession(user_id=user_a.id)
    db.add(session)
    await db.flush()
    message = ConversationMessage(session_id=session.id, role="assistant", content="", run_id="run-a", round_id="r1",
        content_json=[{"type": "tool_call", "id": "call-1", "name": "read_file"}])
    db.add(message)
    await db.commit()
    path = Path(__file__).resolve().parents[3] / "alembic/versions/20261022000003_unify_chat_display_timeline.py"
    spec = importlib.util.spec_from_file_location("timeline_revision", path)
    revision = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(revision)
    def upgrade(connection):
        with Operations.context(MigrationContext.configure(connection)):
            revision.upgrade()
    connection = await db.connection()
    await connection.run_sync(upgrade)
    await db.refresh(message)
    saved = deepcopy(message.display_timeline)
    assert saved[0]["toolName"] == "read_file"
    assert "toolDurationMs" not in saved[0]
    await connection.run_sync(upgrade)
    await db.refresh(message)
    assert message.display_timeline == saved
    assert message.content_json[0]["type"] == "tool_call"


def test_legacy_records_without_run_id_preserve_round_and_merge_tool_duplicates():
    rows = [row(1, run=None, timeline=[{"kind": "tool", "toolCallId": "call-1", "toolStatus": "running"}]),
        row(2, run=None, timeline=[{"kind": "tool", "toolCallId": "call-1", "toolStatus": "success", "toolDurationMs": 987}]),
        row(3, run=None, blocks=[{"type": "tool_call", "id": "call-1", "name": "read_file"}]),
        row(4, run=None, role="tool", blocks=[{"type": "tool_result", "tool_call_id": "call-1", "content": "ok"}])]
    apply(rows)
    tools = [item for value in rows for item in value.display_timeline or []]
    assert len(tools) == 1
    assert tools[0]["roundId"] == "r1"
    assert tools[0]["toolDurationMs"] == 987
    assert apply(rows) == {}


def test_recorded_cancelled_state_is_not_reclassified_by_canonical_result():
    rows = [row(1, timeline=[{"kind": "tool", "toolCallId": "call-1", "toolStatus": "cancelled"}]),
        row(2, blocks=[{"type": "tool_call", "id": "call-1", "name": "read_file"}]),
        row(3, role="tool", blocks=[{"type": "tool_result", "tool_call_id": "call-1", "content": "已取消"}])]
    apply(rows)
    assert rows[0].display_timeline[0]["toolStatus"] == "cancelled"
    assert apply(rows) == {}


def test_chat_tool_events_restore_call_and_result_as_one_bubble():
    from datetime import datetime, timezone

    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    result_created = datetime(2026, 8, 22, 7, 0, 1, tzinfo=timezone.utc)
    assistant = SimpleNamespace(
        id=10, created_at=created,
        content_json=[{"type": "tool_call", "id": "call-1", "name": "weather", "arguments": {"city": "南京"}}],
    )
    result = SimpleNamespace(
        id=11, created_at=result_created,
        content_json=[{"type": "tool_result", "tool_call_id": "call-1", "content": "晴天"}],
    )
    assert build_chat_tool_events([assistant, result]) == [{
        "id": "tool:call-1", "toolCallId": "call-1", "timelineOrder": 11, "toolName": "weather",
        "toolLabel": "weather",
        "toolInput": {"city": "南京"}, "toolResult": "晴天", "toolStatus": "success",
        "createdAt": created, "updatedAt": result_created,
    }]


def test_chat_tool_events_scope_reused_provider_ids_to_run_and_round():
    from datetime import datetime, timezone

    first_created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    second_created = datetime(2026, 8, 22, 7, 1, tzinfo=timezone.utc)
    first_result_at = datetime(2026, 8, 22, 7, 0, 1, tzinfo=timezone.utc)
    second_result_at = datetime(2026, 8, 22, 7, 1, 1, tzinfo=timezone.utc)
    rows = [
        SimpleNamespace(id=10, created_at=first_created, run_id="run-a", round_id="r1",
            content_json=[{"type": "tool_call", "id": "call-1", "name": "search", "arguments": {}}]),
        SimpleNamespace(id=11, created_at=first_result_at, run_id="run-a", round_id="r1",
            content_json=[{"type": "tool_result", "tool_call_id": "call-1", "content": "first"}]),
        SimpleNamespace(id=20, created_at=second_created, run_id="run-b", round_id="r1",
            content_json=[{"type": "tool_call", "id": "call-1", "name": "search", "arguments": {}}]),
        SimpleNamespace(id=21, created_at=second_result_at, run_id="run-b", round_id="r1",
            content_json=[{"type": "tool_result", "tool_call_id": "call-1", "content": "second"}]),
    ]

    events = build_chat_tool_events(rows)

    assert [(event["runId"], event["roundId"], event["toolCallId"], event["toolResult"])
            for event in events] == [
        ("run-a", "r1", "call-1", "first"),
        ("run-b", "r1", "call-1", "second"),
    ]
    assert events[0]["id"] != events[1]["id"]


def test_chat_tool_events_restore_name_when_result_is_scanned_before_call():
    """历史块顺序异常时也不能把具体工具名退化成通用「工具调用」。"""
    from datetime import datetime, timezone

    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    result_created = datetime(2026, 8, 22, 7, 0, 1, tzinfo=timezone.utc)
    result = SimpleNamespace(
        id=21, created_at=result_created,
        content_json=[{"type": "tool_result", "tool_call_id": "call-1", "content": "晴天"}],
    )
    assistant = SimpleNamespace(
        id=20, created_at=created,
        content_json=[{"type": "tool_call", "id": "call-1", "name": "weather", "arguments": {}}],
    )

    events = build_chat_tool_events([result, assistant])

    assert events[0]["toolName"] == "weather"
    assert events[0]["toolLabel"] == "weather"
    assert events[0]["toolResult"] == "晴天"


def test_chat_tool_events_use_tool_name_from_result_only_legacy_record():
    from datetime import datetime, timezone

    result = SimpleNamespace(
        id=22, created_at=datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc),
        content_json=[{
            "type": "tool_result", "tool_call_id": "call-legacy",
            "tool_name": "image_search", "content": "候选图",
        }],
    )

    events = build_chat_tool_events([result])

    assert events[0]["toolName"] == "image_search"
    assert events[0]["toolLabel"] == "图片搜索"


def test_chat_tool_events_restore_registered_tool_label():
    from datetime import datetime, timezone

    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    assistant = SimpleNamespace(
        id=14, created_at=created,
        content_json=[{"type": "tool_call", "id": "call-image", "name": "image_search", "arguments": {}}],
    )
    events = build_chat_tool_events([assistant])
    assert events[0]["toolName"] == "image_search"
    assert events[0]["toolLabel"] == "图片搜索"
    assert events[0]["timelineOrder"] == 14


def test_chat_tool_events_unwrap_fixed_adapter_call_tool():
    """刷新恢复时显示业务工具名，不把固定 Adapter 名称显示成「调用工具」。"""
    from datetime import datetime, timezone

    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    result_created = datetime(2026, 8, 22, 7, 0, 1, tzinfo=timezone.utc)
    assistant = SimpleNamespace(
        id=16, created_at=created,
        content_json=[{
            "type": "tool_call", "id": "call-adapter", "name": "call_tool",
            "arguments": {"name": "image_search", "arguments": {"query": "角色"}},
        }],
    )
    result = SimpleNamespace(
        id=17, created_at=result_created,
        content_json=[{"type": "tool_result", "tool_call_id": "call-adapter", "content": "结果"}],
    )

    events = build_chat_tool_events([assistant, result])

    assert events[0]["toolName"] == "image_search"
    assert events[0]["toolLabel"] == "图片搜索"
    assert events[0]["toolInput"] == {"query": "角色"}


def test_chat_tool_events_unwrap_openai_adapter_arguments():
    """OpenAI canonical arguments 是 JSON 字符串时也要恢复业务工具名。"""
    from datetime import datetime, timezone
    import json

    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    assistant = SimpleNamespace(
        id=18, created_at=created,
        content_json=[{
            "type": "tool_call", "id": "call-adapter-openai", "name": "call_tool",
            "arguments": json.dumps(
                {"name": "web_search", "arguments": {"query": "天气"}},
                ensure_ascii=False,
            ),
        }],
    )

    events = build_chat_tool_events([assistant])

    assert events[0]["toolName"] == "web_search"
    assert events[0]["toolLabel"] == "联网搜索"
    assert events[0]["toolInput"] == {"query": "天气"}


def test_chat_tool_events_restore_legacy_anthropic_tool_use():
    from datetime import datetime, timezone

    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    assistant = SimpleNamespace(
        id=15, created_at=created,
        content_json=[{"type": "tool_use", "id": "call-image", "name": "image_search", "input": {}}],
    )
    events = build_chat_tool_events([assistant])
    assert events[0]["toolLabel"] == "图片搜索"
    assert events[0]["toolInput"] == {}


def test_chat_tool_events_restores_legacy_error_result_as_error():
    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    result_created = datetime(2026, 8, 22, 7, 0, 1, tzinfo=timezone.utc)
    assistant = SimpleNamespace(
        id=12, created_at=created,
        content_json=[{"type": "tool_call", "id": "call-2", "name": "permanent_delete", "arguments": {}}],
    )
    result = SimpleNamespace(
        id=13, created_at=result_created,
        content_json=[{"type": "tool_result", "tool_call_id": "call-2",
                       "content": '{"error":"文件夹不在回收站"}'}],
    )
    events = build_chat_tool_events([assistant, result])
    assert events[0]["toolStatus"] == "error"
