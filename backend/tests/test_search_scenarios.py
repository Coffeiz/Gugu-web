"""站内搜索的场景脚本：覆盖用户没有指定对象类型时的工具选择边界。"""

from app.models import CalendarEvent, ConversationMessage, ConversationSession, File, MindNode, Project
from app.api.v1.search import run_global_search
from agent import imctx
from agent.tools.conversations import _search_conversations
from agent.tools.global_search import _global_search
from agent.tools.group_context import _group_context_search
from agent.tools.mind import _mind_search


async def _add(db, obj):
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


async def test_scenario_without_target_searches_all_relevant_types(db, user_a):
    await _add(db, Project(user_id=user_a.id, name="上线项目"))
    await _add(db, File(user_id=user_a.id, display_name="部署说明", ext="md", storage_key="scenario-file", size=10))
    await _add(db, CalendarEvent(user_id=user_a.id, title="发布会议", date="2026-08-04"))

    result = await _global_search(db, user_a.id, {"queries": ["上线", "部署", "发布"]})

    assert {group["type"] for group in result["groups"]} == {"project", "file", "event"}
    assert result["mode"] == "OR"


async def test_scenario_explicit_target_does_not_expand_search_scope(db, user_a):
    await _add(db, Project(user_id=user_a.id, name="部署项目"))
    await _add(db, File(user_id=user_a.id, display_name="部署说明", ext="md", storage_key="scenario-file", size=10))

    result = await _global_search(
        db, user_a.id, {"queries": ["部署"], "types": ["project"]},
    )

    assert [group["type"] for group in result["groups"]] == ["project"]
    assert result["groups"][0]["items"][0]["title"] == "部署项目"


async def test_scenario_and_requires_all_terms_in_one_record(db, user_a):
    await _add(db, Project(user_id=user_a.id, name="部署方案"))
    await _add(db, Project(user_id=user_a.id, name="上线清单"))
    await _add(db, Project(user_id=user_a.id, name="部署上线方案"))

    result = await _global_search(
        db, user_a.id, {"queries": ["部署", "上线"], "types": ["project"], "mode": "AND"},
    )

    assert [item["title"] for item in result["groups"][0]["items"]] == ["部署上线方案"]


async def test_scenario_history_search_uses_multiple_terms_once(db, user_a):
    session = await _add(db, ConversationSession(user_id=user_a.id, title="部署讨论"))
    await _add(db, ConversationMessage(session_id=session.id, role="user", content="上线清单"))

    result = await _search_conversations(db, user_a.id, {"queries": ["部署", "上线"]})

    assert [item["session_id"] for item in result["matches"]] == [session.id]


async def test_scenario_mind_search_uses_multiple_terms_once(db, user_a):
    await _add(db, MindNode(user_id=user_a.id, kind="note", title="部署方案", content_md="", content_plain="部署"))
    await _add(db, MindNode(user_id=user_a.id, kind="note", title="上线清单", content_md="", content_plain="上线"))

    result = await _mind_search(db, user_a.id, {"queries": ["部署", "上线"]})

    assert {match["title"] for match in result["matches"]} == {"部署方案", "上线清单"}


async def test_scenario_group_search_stays_in_current_group(db, user_a):
    current = await _add(db, ConversationSession(
        user_id=user_a.id, source="qqbot", bot_id="scenario-bot", chat_id="scenario-group-a", title="群 A",
    ))
    other = await _add(db, ConversationSession(
        user_id=user_a.id, source="qqbot", bot_id="scenario-bot", chat_id="scenario-group-b", title="群 B",
    ))
    await _add(db, ConversationMessage(session_id=current.id, role="user", content="部署方案"))
    await _add(db, ConversationMessage(session_id=other.id, role="user", content="部署方案"))
    imctx.set_im("qqbot", "scenario-member", "scenario-bot", "scenario-group-a", "member", "group")

    try:
        result = await _group_context_search(db, user_a.id, {"queries": ["部署", "方案"]})
    finally:
        imctx.clear()

    assert [message["content"] for message in result["messages"]] == ["部署方案"]


async def test_scenario_no_target_match_returns_explainable_empty_result(db, user_a):
    result = await _global_search(db, user_a.id, {"queries": ["不存在的项目", "不存在的文件"]})

    assert result["total"] == 0
    assert "不搜文件内容" in result["note"]
