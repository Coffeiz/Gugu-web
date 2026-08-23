from agent.context.compaction import compact_context
from agent.context.compress_conv import fixed_context_parts
from agent.context.message_assembly import build_messages


def test_message_assembly_marks_snapshot_prefix():
    messages = build_messages(
        fixed_parts=[{"role": "system", "content": "固定系统"},
                     {"role": "user", "content": "固定 session info"}],
        history=[{"role": "user", "content": "旧消息"}],
        current_user={"role": "user", "content": "当前消息"},
        dynamic_tail=[{"role": "user", "content": "当前时间"}],
    )

    assert messages.fixed_prefix_size == 2
    assert [m["content"] for m in messages.conversation[:2]] == ["固定系统", "固定 session info"]
    assert messages.dynamic_tail[0]["content"] == "当前时间"


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


def test_fixed_context_puts_compacted_summary_before_snapshot():
    snapshot = {"role": "user", "content": "大型 session snapshot"}
    parts = fixed_context_parts(snapshot, "早前对话摘要")

    assert "## 早前对话摘要" in parts[0]["content"]
    assert parts[1] is snapshot
