import asyncio
import pytest
from types import SimpleNamespace

from agent.context.compaction import compact_context
from agent.context.compress_conv import fixed_context_parts
from agent.context.assembly import (
    MessageBatch, MessageArea, assemble, assemble_turn, reminder,
)
from agent.context.history import build_history_parts
from agent.context.canonical_tool_history import render_events_for_provider


MODEL_CFG = SimpleNamespace(context_tokens=100, max_tokens=20)


async def _compact_area(messages, **kwargs):
    area = MessageArea.from_canonical_messages(messages)
    return await compact_context(area, **kwargs)


def _history_beyond_protected_window():
    history = []
    for index in range(12):
        history.extend([
            {"role": "user", "content": f"旧消息{index}" * 80},
            {"role": "assistant", "content": f"旧回复{index}" * 80},
        ])
    return history


def test_assembly_marks_snapshot_prefix():
    messages = assemble(
        fixed_parts=[{"role": "system", "content": "固定系统"},
                     {"role": "user", "content": "固定 session info"}],
        history=[{"role": "user", "content": "旧消息"}],
    )
    batch, _ = assemble_turn(
        current_user={"role": "user", "content": "当前消息"},
    )
    messages.set_dynamic_tail([reminder("当前时间：当前时间")])
    messages.append_batch(batch)

    assert messages.fixed_prefix_size == 2
    assert [m["content"] for m in messages.provider_projection().to_messages()[:2]] == ["固定系统", "固定 session info"]
    assert messages.dynamic_tail == [reminder("当前时间：当前时间")]


def test_rag_precedes_current_user_while_current_time_stays_in_dynamic_tail():
    messages = assemble(
        fixed_parts=[{"role": "user", "content": "固定 session info"}],
        history=[{"role": "assistant", "content": "上一轮回复"}],
    )
    batch, _ = assemble_turn(
        current_user={"role": "user", "content": "当前问题"},
        conversation_tail=[{"role": "user", "content": "[group-rag]\n稳定知识"}],
    )
    messages.set_dynamic_tail([reminder("当前时间：当前时间")])
    messages.append_batch(batch)

    assert [item["content"] for item in messages.provider_projection().conversation] == [
        "固定 session info", "上一轮回复", "[group-rag]\n稳定知识", "当前问题",
    ]
    assert messages.dynamic_tail == [reminder("当前时间：当前时间")]
    assert "当前时间：当前时间" not in str(messages.provider_projection().conversation)


def test_compaction_keeps_snapshot_prefix_out_of_summary(monkeypatch):
    async def fake_summary(content_list, prev_summary=None, **_kwargs):
        return "压缩摘要"

    monkeypatch.setattr("agent.context.compaction._generate_append_summary", fake_summary)
    messages = [
        {"role": "system", "content": "固定系统"},
        {"role": "user", "content": "固定 session info"},
        *_history_beyond_protected_window(),
        {"role": "user", "content": "当前消息"},
    ]

    result = __import__("asyncio").run(
        _compact_area(
            messages, fixed_prefix_size=2, model_cfg=MODEL_CFG,
        )
    )

    assert result.changed
    assert result.messages[:2] == messages[:2]
    assert "固定系统" not in result.messages[2]["content"]
    assert "固定 session info" not in result.messages[2]["content"]


def test_fixed_context_contains_only_snapshot():
    snapshot = {"role": "user", "content": "大型 session snapshot"}
    assert fixed_context_parts(snapshot) == [snapshot]


def test_persisted_summary_is_first_history_message():
    class Message:
        role = "summary"
        content = "早前决定"
        content_json = None

    parts = build_history_parts([Message()], object(), use_anthropic=True)
    assert parts[0]["role"] == "user"
    assert parts[0]["content"] == "<compacted-summary>\n早前决定\n</compacted-summary>"


def test_submitted_batch_is_frozen_and_keeps_canonical_projection():
    batch = MessageBatch.from_canonical_messages([
        {"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-1", "name": "weather", "arguments": {},
        }]},
        {"role": "user", "content": [{
            "type": "tool_result", "tool_call_id": "call-1", "content": "晴天",
        }]},
    ])
    messages = MessageArea.from_canonical_messages([{"role": "system", "content": "固定"}])
    messages.append_batch(batch)

    assert batch.sealed is True
    assert batch.batch_digest == batch.batch_digest
    assert [block["type"] for entry in messages.entries
            for block in entry.canonical_message.get("content", [])
            if isinstance(entry.canonical_message.get("content"), list)] == [
        "tool_call", "tool_result",
    ]
    rendered = messages.provider_projection()
    assert rendered.area_digest == messages.digest()
    assert rendered.area_revision == messages.revision
    assert not hasattr(rendered, "canonical_batches")
    with pytest.raises(RuntimeError, match="已提交"):
        batch.append({"role": "user", "content": "不应追加"})
    exposed = batch.canonical_messages
    exposed[0]["content"].clear()
    assert batch.canonical_messages[0]["content"]


def test_message_area_rejects_raw_list_batch():
    area = MessageArea.from_canonical_messages()
    with pytest.raises(TypeError, match="只接受 MessageBatch"):
        area.append_batch([{"role": "user", "content": "裸列表不能进入 Area"}])


def test_area_exposes_immutable_batch_records_for_finalize():
    batch = MessageBatch.from_canonical_messages(
        [{"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-1", "name": "weather", "arguments": {},
        }]}],
        metadata={"round_id": "round-1"},
    )
    messages = MessageArea.from_canonical_messages()
    messages.append_batch(batch)

    records = messages.batch_records()
    assert records[0]["digest"] == batch.batch_digest
    assert records[0]["metadata"] == {"round_id": "round-1"}
    records[0]["metadata"]["round_id"] = "mutated"
    assert messages.batch_records()[0]["metadata"]["round_id"] == "round-1"


def test_canonical_batch_rejects_provider_wire_shape():
    with pytest.raises(TypeError, match="Provider tool wire"):
        MessageBatch.from_canonical_messages([{
            "role": "assistant",
            "content": "",
            "tool_calls": [],
        }])


def test_canonical_batch_is_fixed_before_seal_and_appends_canonical_results():
    canonical = [{
        "role": "assistant",
        "content": [{"type": "tool_call", "id": "call-1", "name": "weather", "arguments": {}}],
    }]
    batch = MessageBatch.from_canonical_messages(canonical)
    batch.append({"role": "user", "content": [{
        "type": "tool_result", "tool_call_id": "call-1", "content": "晴天",
    }]})

    assert batch.sealed is False
    assert len(batch.canonical_messages) == 2
    batch.seal()
    assert [block["type"] for item in batch.canonical_messages for block in item["content"]] == [
        "tool_call", "tool_result",
    ]


def test_inline_and_persisted_summary_keep_identical_provider_prefix(monkeypatch):
    """压缩所在 run 与下一 run 从数据库恢复的摘要必须字节一致。"""
    async def fake_summary(_items, _previous=None, **_kwargs):
        return "稳定摘要"

    monkeypatch.setattr("agent.context.compaction._generate_append_summary", fake_summary)
    messages = [
        {"role": "system", "content": "固定系统"},
        {"role": "user", "content": "固定 snapshot"},
        *_history_beyond_protected_window(),
        {"role": "user", "content": "当前消息"},
    ]

    result = asyncio.run(
        _compact_area(
            messages, fixed_prefix_size=2, model_cfg=MODEL_CFG,
        )
    )

    assert result.changed
    inline_summary = result.messages[2]["content"]

    class PersistedSummary:
        role = "summary"
        content = "稳定摘要"
        content_json = None

    restored = build_history_parts([PersistedSummary()], object(), use_anthropic=True)
    assert inline_summary == restored[0]["content"]
