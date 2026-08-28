import asyncio
import pytest

from agent.context.compaction import compact_context
from agent.context.compress_conv import fixed_context_parts
from agent.context.assembly import NewMessageBatch, PromptMessages, assemble, assemble_turn
from agent.context.history import build_history_parts
from agent.context.canonical_tool_history import render_events_for_provider


def test_assembly_marks_snapshot_prefix():
    messages = assemble(
        fixed_parts=[{"role": "system", "content": "固定系统"},
                     {"role": "user", "content": "固定 session info"}],
        history=[{"role": "user", "content": "旧消息"}],
    )
    batch, _ = assemble_turn(
        current_user={"role": "user", "content": "当前消息"},
        now_text="当前时间",
    )
    messages.append_batch(batch)

    assert messages.fixed_prefix_size == 2
    assert [m["content"] for m in messages.conversation[:2]] == ["固定系统", "固定 session info"]
    assert messages[-1]["content"][0]["text"].endswith("当前时间\n[/system-reminder]")


def test_openai_provider_render_keeps_snapshot_prefix():
    """OpenAI 路不经过 Anthropic 清洗器，provider 渲染也必须保留 snapshot。"""
    messages = assemble(
        fixed_parts=[
            {"role": "system", "content": "固定 snapshot"},
        ],
        history=[{"role": "user", "content": "旧消息"}],
    )
    batch, _ = assemble_turn(
        current_user={"role": "user", "content": "当前消息"},
        now_text="当前时间",
    )
    messages.append_batch(batch)

    outbound = render_events_for_provider(messages)

    assert outbound[0] == {"role": "system", "content": "固定 snapshot"}
    assert [item["content"] for item in outbound.conversation][:3] == [
        "固定 snapshot", "旧消息", "当前消息",
    ]
    assert outbound[-1]["content"][0]["text"].endswith("当前时间\n[/system-reminder]")


def test_rag_tail_is_stable_conversation_after_current_user():
    messages = assemble(
        fixed_parts=[{"role": "user", "content": "固定 session info"}],
        history=[{"role": "assistant", "content": "上一轮回复"}],
    )
    batch, _ = assemble_turn(
        current_user={"role": "user", "content": "当前问题"},
        conversation_tail=[{"role": "user", "content": "[group-rag]\n稳定知识"}],
        now_text="当前时间",
    )
    messages.append_batch(batch)

    assert [item["content"] for item in messages.conversation] == [
        "固定 session info", "上一轮回复", "当前问题", "[group-rag]\n稳定知识",
        [{"type": "time-context", "text": "[system-reminder]\n当前时间：当前时间\n[/system-reminder]"}],
    ]
    assert messages[-1]["content"][0]["text"].endswith("当前时间\n[/system-reminder]")


def test_compaction_keeps_snapshot_prefix_out_of_summary(monkeypatch):
    async def fake_summary(content_list, prev_summary=None):
        return "压缩摘要"

    monkeypatch.setattr("agent.context.compaction._generate_compact_summary", fake_summary)
    messages = [
        {"role": "system", "content": "固定系统"},
        {"role": "user", "content": "固定 session info"},
        {"role": "user", "content": "旧消息" * 80},
        {"role": "assistant", "content": "旧回复" * 80},
        {"role": "user", "content": "当前消息"},
    ]

    compacted, did_compact = __import__("asyncio").run(
        compact_context(messages, "", context_tokens=100, fixed_prefix_size=2)
    )

    assert did_compact
    assert compacted[:2] == messages[:2]
    assert "固定系统" not in compacted[2]["content"]
    assert "固定 session info" not in compacted[2]["content"]


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
    batch = NewMessageBatch([
        {"role": "assistant", "tool_calls": [{
            "id": "call-1", "function": {"name": "weather", "arguments": "{}"},
        }]},
        {"role": "tool", "tool_call_id": "call-1", "content": "晴天"},
    ])
    messages = PromptMessages([{"role": "system", "content": "固定"}])
    messages.append_batch(batch)

    assert batch.sealed is True
    assert batch.batch_digest == batch.batch_digest
    assert [block["type"] for item in messages.canonical_batches for block in item["content"]] == [
        "tool_call", "tool_result",
    ]
    rendered = render_events_for_provider(messages)
    assert rendered.canonical_batches == messages.canonical_batches
    assert rendered.canonical_batch_digests == messages.canonical_batch_digests
    with pytest.raises(RuntimeError, match="已提交"):
        batch.append({"role": "user", "content": "不应追加"})
    with pytest.raises(RuntimeError, match="已提交"):
        batch.messages.append({"role": "user", "content": "不应直接追加"})


def test_prompt_messages_exposes_immutable_batch_records_for_finalize():
    batch = NewMessageBatch.from_canonical_messages(
        [{"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-1", "name": "weather", "arguments": {},
        }]}],
        metadata={"round_id": "round-1"},
    )
    messages = PromptMessages()
    messages.append_batch(batch)

    records = messages.canonical_batch_records
    assert records[0]["digest"] == batch.batch_digest
    assert records[0]["metadata"] == {"round_id": "round-1"}
    records[0]["metadata"]["round_id"] = "mutated"
    assert messages.canonical_batch_records[0]["metadata"]["round_id"] == "round-1"


def test_canonical_batch_rejects_provider_wire_shape():
    with pytest.raises(TypeError, match="Provider tool wire"):
        NewMessageBatch.from_canonical_messages([{
            "role": "assistant",
            "content": "",
            "tool_calls": [],
        }])


def test_canonical_batch_is_fixed_before_seal_and_append_updates_both_projections():
    canonical = [{
        "role": "assistant",
        "content": [{"type": "tool_call", "id": "call-1", "name": "weather", "arguments": {}}],
    }]
    provider = [{
        "role": "assistant",
        "content": None,
        "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "weather", "arguments": "{}"}}],
    }]
    batch = NewMessageBatch.from_canonical_messages(canonical, provider_messages=provider)
    batch.append({"role": "tool", "content": [{
        "type": "tool_result", "tool_call_id": "call-1", "content": "晴天",
    }]})

    assert batch.sealed is False
    assert len(batch.canonical_messages) == 2
    assert batch.provider_messages[0]["tool_calls"][0]["id"] == "call-1"
    batch.seal()
    assert [block["type"] for item in batch.canonical_messages for block in item["content"]] == [
        "tool_call", "tool_result",
    ]


def test_inline_and_persisted_summary_keep_identical_provider_prefix(monkeypatch):
    """压缩所在 run 与下一 run 从数据库恢复的摘要必须字节一致。"""
    async def fake_summary(_items, _previous=None):
        return "稳定摘要"

    monkeypatch.setattr("agent.context.compaction._generate_compact_summary", fake_summary)
    messages = [
        {"role": "system", "content": "固定系统"},
        {"role": "user", "content": "固定 snapshot"},
        {"role": "user", "content": "旧消息" * 80},
        {"role": "assistant", "content": "旧回复" * 80},
        {"role": "user", "content": "当前消息"},
    ]

    compacted, changed = asyncio.run(
        compact_context(messages, "", context_tokens=100, fixed_prefix_size=2)
    )

    assert changed
    inline_summary = compacted[2]["content"]

    class PersistedSummary:
        role = "summary"
        content = "稳定摘要"
        content_json = None

    restored = build_history_parts([PersistedSummary()], object(), use_anthropic=True)
    assert inline_summary == restored[0]["content"]
