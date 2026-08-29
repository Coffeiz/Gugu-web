from agent.context.canonical_context import (
    CanonicalContext,
    CanonicalTurn,
    HistoryEnvelope,
    group_history_units,
    normalize_history_message,
    tool_call_ids,
    tool_result_ids,
)


def test_tool_call_and_result_are_one_history_unit():
    history = [
        {"role": "user", "content": "先查一下"},
        {"role": "assistant", "content": [{"type": "tool_call", "id": "t1", "name": "search", "arguments": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_call_id": "t1", "content": "ok"}]},
        {"role": "assistant", "content": "结果如下"},
    ]
    units = group_history_units(history)
    assert [unit.kind for unit in units] == ["message", "tool_turn", "message"]
    assert units[1].message_count == 2


def test_tool_unit_requires_matching_call_id():
    history = [
        {"role": "assistant", "tool_calls": [{"id": "call-a"}], "content": None},
        {"role": "tool", "tool_call_id": "call-b", "content": "orphan"},
    ]
    units = group_history_units(history)
    assert [unit.kind for unit in units] == ["message", "message"]
    assert tool_call_ids(history[0]) == frozenset({"call-a"})
    assert tool_result_ids(history[1]) == frozenset({"call-b"})


def test_section_digest_changes_only_when_section_changes():
    base = CanonicalContext(static_system=({"role": "system", "content": "固定"},))
    changed = CanonicalContext(
        static_system=base.static_system,
        current_turn=({"role": "system", "content": "现在"},),
    )
    assert base.section_digests["static_system"] == changed.section_digests["static_system"]
    assert base.section_digests["current_turn"] != changed.section_digests["current_turn"]
    assert base.canonical_digest != changed.canonical_digest


def test_history_envelope_keeps_quote_attachment_time_and_unknown_block_contract():
    envelope = normalize_history_message({
        "role": "user",
        "content": "看这张图",
        "quoted_text": "上一条消息",
        "files": [{"attach_id": "att-1", "name": "图.png", "url": "signed-url"}],
        "sent_at": "2026-08-25T10:00:00+08:00",
        "platform_user_id": "member-1",
        "platform_user_name": "小北",
        "source": "qq",
        "content_json": [
            {"type": "text", "text": "看这张图"},
            {"type": "future-block", "value": "保留为稳定文本"},
        ],
    })
    assert isinstance(envelope, HistoryEnvelope)
    assert envelope.quote == {"type": "quote", "text": "上一条消息"}
    assert envelope.attachments[0]["attach_id"] == "att-1"
    assert "url" not in envelope.attachments[0]
    assert envelope.sent_at == "2026-08-25T10:00:00+08:00"
    assert envelope.sender == {"id": "member-1", "name": "小北"}
    assert envelope.unknown_block_count == 1
    assert envelope.content_blocks[-1]["type"] == "text"
    assert envelope.digest == normalize_history_message({
        "role": "user", "content_json": list(envelope.content_blocks),
        "quoted_text": "上一条消息", "files": [{"attach_id": "att-1", "name": "图.png"}],
        "sent_at": envelope.sent_at, "platform_user_id": "member-1",
        "platform_user_name": "小北", "source": "qq",
    }).digest


def test_canonical_turn_digest_is_content_based():
    first = normalize_history_message({"role": "user", "content": "hello"})
    second = normalize_history_message({"role": "assistant", "content": "world"})
    turn = CanonicalTurn((first, second))
    assert turn.digest
    assert turn.messages == (first, second)
