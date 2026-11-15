"""历史对话读取的排序、普通消息过滤和字符截断回归。"""
from sqlalchemy import null

from agent.tools.conversations import ConversationsSkill, _fmt_from_iso, _read_conversation, _resolve_conversation_session_id
from agent.tools.tool_contract import normalize_and_validate_tool_input
from app.models import ConversationMessage, ConversationSession


def test_read_conversation_normalizes_legacy_numeric_arguments():
    tool = next(item for item in ConversationsSkill.tools if item.name == "read_conversation")
    value, issues, legacy, adaptations = normalize_and_validate_tool_input(
        "read_conversation", {"session_id": "#１", "limit": "2"}, tool,
    )
    assert value == {"session_id": 1, "limit": 2}
    assert issues == [] and legacy == []
    assert adaptations == ["session_id:string_to_integer", "limit:string_to_integer"]


def test_history_search_timestamp_date_only_and_invalid():
    assert _fmt_from_iso("2026-01-02") == "2026-01-02 00:00"
    assert _fmt_from_iso("2026-02-30T03:04:00Z") == ""
    assert _fmt_from_iso("20260102T030405") == "2026-01-02 03:04"
    assert _fmt_from_iso("2026-W01-5") == "2026-01-02 00:00"
    assert _fmt_from_iso("2026-W01") == "2025-12-29 00:00"
    assert _fmt_from_iso("2026-01-02x03:04:05,123+08") == "2026-01-02 03:04"
    assert _fmt_from_iso("2026-01-02T03:04:05+24:00") == ""


async def test_read_conversation_limits_before_empty_filter_and_preserves_unicode(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="合成对话", source="web")
    db.add(session)
    await db.flush()
    db.add_all([
        ConversationMessage(session_id=session.id, conversation_seq=1, role="user", content="旧消息", content_json=null()),
        ConversationMessage(session_id=session.id, conversation_seq=2, role="tool", content="工具文本", content_json=null()),
        ConversationMessage(session_id=session.id, conversation_seq=3, role="assistant", content="结构化", content_json=[{"type": "tool_call"}]),
        ConversationMessage(session_id=session.id, conversation_seq=4, role="user", content="😀" * 1201, content_json=null()),
        ConversationMessage(session_id=session.id, conversation_seq=5, role="assistant", content="", content_json=null()),
    ])
    await db.commit()
    result = await _read_conversation(db, user_a.id, {"session_id": session.id, "limit": 2})
    assert result == {"session_id": session.id, "title": "合成对话", "source": "web", "messages": [{"role": "你", "content": "😀" * 1200}]}
    result = await _read_conversation(db, user_a.id, {"session_id": session.id, "limit": 4})
    assert [item["content"] for item in result["messages"]] == ["旧消息", "工具文本", "😀" * 1200]
    assert [item["role"] for item in result["messages"]] == ["你", "咕咕", "你"]


async def test_history_index_identifiers_never_override_owner_or_explicit_session(db, user_a, user_b):
    own = ConversationSession(user_id=user_a.id, title="自己的对话")
    other = ConversationSession(user_id=user_b.id, title="其他对话")
    db.add_all([own, other])
    await db.flush()
    own_message = ConversationMessage(session_id=own.id, conversation_seq=1, role="user", content="正文")
    other_message = ConversationMessage(session_id=other.id, conversation_seq=1, role="user", content="其他正文")
    db.add_all([own_message, other_message])
    await db.commit()
    assert await _resolve_conversation_session_id(db, user_a.id, {"session_id": other.id, "message_id": own_message.id}) is None
    assert await _resolve_conversation_session_id(db, user_a.id, {"message_id": other_message.id, "source_id": own.id}) is None
    assert await _resolve_conversation_session_id(db, user_a.id, {"message_id": own_message.id, "source_id": other.id}) == own.id
    assert await _resolve_conversation_session_id(db, user_a.id, {"source_id": str(own.id)}) == own.id
