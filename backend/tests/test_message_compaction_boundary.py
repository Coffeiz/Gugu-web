from agent.context.compaction import compact_context
from agent.context.compress_conv import fixed_context_parts
from agent.context.message_assembly import build_messages
from agent.context.history import build_history_parts
from agent.context.canonical_tool_history import render_events_for_provider


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


def test_openai_provider_render_keeps_snapshot_prefix():
    """OpenAI 路不经过 Anthropic 清洗器，provider 渲染也必须保留 snapshot。"""
    messages = build_messages(
        fixed_parts=[
            {"role": "system", "content": "固定 snapshot"},
        ],
        history=[{"role": "user", "content": "旧消息"}],
        current_user={"role": "user", "content": "当前消息"},
        dynamic_tail=[{"role": "system", "content": "当前时间"}],
    )

    outbound = render_events_for_provider(messages.conversation)

    assert outbound[0] == {"role": "system", "content": "固定 snapshot"}
    assert [item["content"] for item in outbound] == ["固定 snapshot", "旧消息", "当前消息"]


def test_rag_tail_is_stable_conversation_after_current_user():
    messages = build_messages(
        fixed_parts=[{"role": "user", "content": "固定 session info"}],
        history=[{"role": "assistant", "content": "上一轮回复"}],
        current_user={"role": "user", "content": "当前问题"},
        conversation_tail=[{"role": "user", "content": "[group-rag]\n稳定知识"}],
        dynamic_tail=[{"role": "user", "content": "当前时间"}],
    )

    assert [item["content"] for item in messages.conversation] == [
        "固定 session info", "上一轮回复", "当前问题", "[group-rag]\n稳定知识",
    ]
    assert [item["content"] for item in messages.dynamic_tail] == ["当前时间"]


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
    assert "## 早前对话摘要" in parts[0]["content"]
    assert "早前决定" in parts[0]["content"]
