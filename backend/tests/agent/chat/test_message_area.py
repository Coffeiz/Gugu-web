import pytest
from datetime import datetime, timezone
from types import SimpleNamespace

from agent.context.assembly import (
    MessageArea,
    MessageSource,
    MessageBatch,
    PersistencePolicy,
    assemble_turn,
)


def test_append_keeps_prior_entries_immutable_and_assigns_monotonic_sequences():
    area = MessageArea()
    original = {"role": "user", "content": [{"type": "text", "text": "首条"}]}
    first = area.append(
        original,
        source=MessageSource.USER,
        persistence_policy=PersistencePolicy.ALREADY_PERSISTED,
    )
    original["content"][0]["text"] = "外部修改"
    first_read = first.canonical_message
    first_read["content"][0]["text"] = "读取副本修改"

    second = area.append({"role": "assistant", "content": "回复"})

    assert [entry.sequence for entry in area.entries] == [0, 1]
    assert first.canonical_message["content"][0]["text"] == "首条"
    assert area.entries[0] is first
    assert second.revision > first.revision


def test_append_batch_assigns_contiguous_entries_and_snapshot_is_immutable():
    area = MessageArea.from_restored([{"role": "user", "content": "之前"}])
    batch = MessageBatch.from_canonical_messages(
        [
            {"role": "assistant", "content": [{
                "type": "tool_call", "id": "call-1", "name": "weather", "arguments": {},
            }]},
            {"role": "user", "content": [{
                "type": "tool_result", "tool_call_id": "call-1", "content": "等待确认",
            }]},
        ],
        metadata={"round_id": "round-1"},
    )
    old_entry = area.entries[0]
    old_digest = area.digest()
    appended = area.append_batch(batch)

    assert [entry.sequence for entry in appended] == [1, 2]
    assert len({entry.batch_id for entry in appended}) == 1
    assert all(entry.source is MessageSource.TOOL_ROUND for entry in appended)
    assert all(entry.persistence_policy is PersistencePolicy.COMMIT_ON_SUCCESS for entry in appended)
    assert old_entry.canonical_message["content"] == "之前"
    assert area.revision == 1
    assert area.digest() != old_digest
    assert area.snapshot().messages[1]["role"] == "assistant"


def test_pending_result_resolution_is_an_explicit_revisioned_area_edit():
    area = MessageArea()
    area.append_batch(MessageBatch.from_canonical_messages([
        {"role": "user", "content": [{
            "type": "tool_result", "tool_call_id": "call-9", "content": "waiting",
        }]},
    ], metadata={"round_id": "round-2"}))
    entry = area.entries[0]
    revision_before = area.revision
    digest_before = area.digest()
    batch_digest_before = area.batch_records()[0]["digest"]

    updated = area.resolve_pending_tool_result(
        entry.entry_id,
        {"status": "success", "value": 4},
    )

    assert updated.entry_id == entry.entry_id
    assert updated.sequence == entry.sequence
    assert updated.revision > entry.revision
    assert area.revision == revision_before + 1
    assert area.digest() != digest_before
    assert area.batch_records()[0]["digest"] != batch_digest_before
    assert entry.canonical_message["content"][0]["content"] == "waiting"
    assert area.entries[0].canonical_message["content"][0]["content"] == '{"status": "success", "value": 4}'


def test_baseline_replace_requires_expected_revision_and_noops_identical_content():
    area = MessageArea.from_restored([{"role": "user", "content": "已有"}])
    revision = area.revision
    area.replace_baseline([{"role": "user", "content": "已有"}], expected_revision=revision)
    assert area.revision == revision

    area.replace_baseline([{"role": "user", "content": "摘要"}], expected_revision=revision)
    assert area.revision == revision + 1
    with pytest.raises(RuntimeError, match="revision 已变化"):
        area.replace_baseline([], expected_revision=revision)


def test_prompt_compaction_replaces_canonical_baseline_and_keeps_persisted_identity():
    area = MessageArea.from_restored([{"role": "user", "content": "旧历史"}])
    current = area.append(
        {"role": "user", "content": "当前问题"},
        source=MessageSource.USER,
        persistence_policy=PersistencePolicy.ALREADY_PERSISTED,
        persisted_message_id=42,
    )
    area.configure_request(fixed_prefix=[{"role": "system", "content": "固定"}])
    revision = area.revision

    area.replace_request_baseline([
        {"role": "system", "content": "固定"},
        {"role": "user", "content": "压缩摘要"},
        {"role": "user", "content": "当前问题"},
    ], expected_revision=revision)

    entries = area.entries
    assert [entry.canonical_message["content"] for entry in entries] == ["压缩摘要", "当前问题"]
    assert entries[0].persistence_policy is PersistencePolicy.REQUEST_ONLY
    assert entries[1].entry_id == current.entry_id
    assert entries[1].persisted_message_id == 42
    assert entries[1].persistence_policy is PersistencePolicy.ALREADY_PERSISTED
    assert area.revision == revision + 1


def test_persistence_delta_selects_entries_by_run_outcome():
    area = MessageArea()
    area.append(
        {"role": "user", "content": "已提前保存"},
        persistence_policy=PersistencePolicy.ALREADY_PERSISTED,
    )
    area.append(
        {"role": "user", "content": "本次临时请求"},
        persistence_policy=PersistencePolicy.REQUEST_ONLY,
    )
    success_entry = area.append(
        {"role": "assistant", "content": "可提交"},
        persistence_policy=PersistencePolicy.COMMIT_ON_SUCCESS,
    )
    interruption_entry = area.append(
        {"role": "assistant", "content": "中断时保留"},
        persistence_policy=PersistencePolicy.COMMIT_ON_INTERRUPTION,
    )

    assert area.persistence_delta(outcome="success").entries == (success_entry,)
    assert area.persistence_delta(outcome="interruption").entries == (
        success_entry, interruption_entry,
    )


def test_persistence_delta_anchors_rag_before_current_user_not_old_history():
    area = MessageArea.from_restored([{
        "_history_id": 101,
        "role": "user",
        "content": "较早的已持久化历史",
    }])
    prompt = area
    batch, _ = assemble_turn(
        conversation_tail=[{"role": "user", "content": "本轮 RAG"}],
        message_time={"role": "user", "content": "消息时间"},
        current_user={"role": "user", "content": "当前问题"},
    )
    batch.update_area_entry("current_user", persisted_message_id=102)
    prompt.append_batch(batch)

    delta = area.persistence_delta(outcome="success")
    current_user_sequence = next(
        entry.sequence for entry in area.entries
        if entry.persisted_message_id == 102
    )

    assert delta.user_anchor_sequence == current_user_sequence
    assert [entry.source for entry in delta.entries] == [MessageSource.RAG]


def test_repository_restore_preserves_persisted_message_identity_and_timestamp():
    from agent.context.message_area_repository import restore_entries

    row = SimpleNamespace(
        id=42,
        role="user",
        content="已保存的历史",
        content_json=None,
        sent_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
        quoted_text="引用内容",
        references_json=None,
        files=[{"attach_id": "synthetic-attachment", "kind": "image"}],
        chat_type="private",
        platform_user_id="synthetic-user",
        platform_user_name="小北",
    )

    area = restore_entries([row])

    entry = area.entries[0]
    record = entry.canonical_message
    assert entry.persisted_message_id == 42
    assert record["_history_id"] == 42
    assert record["sent_at"] == "2026-10-01T00:00:00+00:00"
    assert record["quoted_text"] == "引用内容"
    assert record["files"] == [{"attach_id": "synthetic-attachment", "kind": "image"}]


def test_area_batch_records_remain_canonical_and_provider_projection_is_detached():
    messages = MessageArea.from_canonical_messages([{"role": "system", "content": "固定"}], fixed_prefix_size=1)
    batch = MessageBatch.from_canonical_messages(
        [{"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-2", "name": "weather", "arguments": {},
        }]}],
        metadata={"round_id": "round-3"},
    )
    messages.append_batch(batch)
    area_digest = messages.digest()
    view = messages.provider_projection()
    detached = view.to_messages()
    detached.append({"role": "user", "content": "projection-only"})

    assert messages.batch_records()[0]["metadata"] == {"round_id": "round-3"}
    assert messages.digest() == area_digest
    assert len(view) == 2
    assert not hasattr(messages, "_canonical_batches")
