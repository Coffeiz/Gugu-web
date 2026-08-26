import asyncio

from agent.context.compaction import compact_context
from agent.context.compress_conv import fixed_context_parts
from agent.context.assembly import assemble, assemble_turn
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
