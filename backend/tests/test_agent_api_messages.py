"""API 层直调测试：会话消息读取端点的窗口/过滤/工具气泡契约。

沿用 test_trash_folders 的姿势——直接调路由函数（current_user/db 显式传），
不起 HTTP 层；conftest 提供内存 SQLite 与双用户夹具。
对应 CRAP-FULL 高危清单里最大的单体：get_session_messages（CC=50）。
"""

import pytest
from fastapi import HTTPException

from app.api.v1 import agent as agent_api
from app.models import ConversationMessage, ConversationSession


@pytest.fixture(autouse=True)
def _api_env(monkeypatch):
    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr("agent.context.compress_conv.recover_orphaned_session", _noop)
    monkeypatch.setattr(agent_api, "filesystem_authorization_enabled", lambda: False)


async def _mk_session(db, user) -> ConversationSession:
    session = ConversationSession(user_id=user.id)
    db.add(session)
    await db.flush()
    return session


async def _mk_message(db, session_id: int, role: str, content: str, **kwargs) -> ConversationMessage:
    message = ConversationMessage(session_id=session_id, role=role, content=content, **kwargs)
    db.add(message)
    await db.flush()
    return message


async def test_get_session_messages_404_for_foreign_or_missing_session(db, user_a, user_b):
    session = await _mk_session(db, user_b)
    with pytest.raises(HTTPException) as exc:
        await agent_api.get_session_messages(session.id, current_user=user_a, db=db)
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as missing:
        await agent_api.get_session_messages(424242, current_user=user_a, db=db)
    assert missing.value.status_code == 404


async def test_get_session_messages_window_filters_and_has_more(db, user_a):
    session = await _mk_session(db, user_a)
    for index in range(4):
        await _mk_message(db, session.id, "user" if index % 2 == 0 else "assistant", f"m{index}")
    # 两类必须被过滤的行：压缩摘要（role=summary）与工具中间消息（content_json 非空）
    await _mk_message(db, session.id, "summary", "压缩摘要不进气泡")
    await _mk_message(db, session.id, "assistant", "", content_json=[{"type": "tool_use", "id": "c"}])
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, limit=2, current_user=user_a, db=db)

    assert [item["content"] for item in payload["messages"]] == ["m2", "m3"]
    assert payload["pagination"] == {
        "limit": 2, "hasMore": True,
        "oldestId": payload["messages"][0]["id"], "newestId": payload["messages"][1]["id"],
    }
    assert payload["session"]["id"] == session.id
    assert payload["active"] is False
    assert payload["executionState"] == session.execution_state


async def test_get_session_messages_before_id_page_is_newest_first(db, user_a):
    session = await _mk_session(db, user_a)
    for index in range(3):
        await _mk_message(db, session.id, "user", f"m{index}")
    await db.commit()

    # before_id 是「已加载窗口的最旧 id」：返回 id 更小的最新一页，保持新→旧顺序
    payload = await agent_api.get_session_messages(
        session.id, limit=10, before_id=3, current_user=user_a, db=db)

    assert [item["content"] for item in payload["messages"]] == ["m1", "m0"]
    # hasMore 探针 = 「存在比本页第一条更旧的消息」；limit 未用满时 m0 同页也照报 True
    assert payload["pagination"]["hasMore"] is True
    # oldestId/newestId 固定取 msgs[0]/msgs[-1]：before 页保持新→旧，字段名按默认口径
    assert payload["pagination"]["oldestId"] == payload["messages"][0]["id"]
    assert payload["pagination"]["newestId"] == payload["messages"][1]["id"]


async def test_get_session_messages_emits_timeline_and_suppresses_tool_events(db, user_a):
    session = await _mk_session(db, user_a)
    timeline = [
        {"kind": "tool", "name": "http_get"},
        {"kind": "assistant", "text": "结果"},
        {
            "kind": "assistant",
            "text": "",
            "linkButtons": {
                "message": "相关入口",
                "buttons": [{"id": "docs", "label": "文档", "url": "https://example.com/docs"}],
            },
        },
    ]
    await _mk_message(db, session.id, "user", "问题")
    timeline_message = await _mk_message(
        db, session.id, "assistant", "", display_timeline=timeline)
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)

    # 带 display_timeline 的 assistant 轮次走 timelineEvents，不重复进正文列表
    assert all(not (m["role"] == "assistant" and m["content"] == "") for m in payload["messages"])
    events = payload["timelineEvents"]
    assert [event["kind"] for event in events] == ["tool", "assistant", "assistant"]
    assert events[0]["timelineOrder"] == timeline_message.id * 1000 + 1
    assert events[2]["linkButtons"]["buttons"][0]["url"] == "https://example.com/docs"
    assert payload["toolEvents"] == []       # timeline 已含工具项，抑制兼容 toolEvents


async def test_get_session_messages_backfills_legacy_timeline_files(db, user_a):
    """旧版只写 assistant.files 的消息也要在时间线中恢复附件卡。"""
    session = await _mk_session(db, user_a)
    await _mk_message(db, session.id, "user", "发图")
    await _mk_message(
        db, session.id, "assistant", "", display_timeline=[
            {"kind": "assistant", "text": "图片已发送"},
        ], files=[{
            "attach_id": "attachment-1", "name": "结果.png", "ext": "png",
            "kind": "image",
        }])
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)

    assert payload["timelineEvents"][-1]["files"][0]["attach_id"] == "attachment-1"


async def test_get_session_messages_pairs_tool_events_within_window(db, user_a):
    session = await _mk_session(db, user_a)
    await _mk_message(db, session.id, "user", "帮我抓个网页")
    await _mk_message(
        db, session.id, "assistant", "",
        content_json=[{"type": "tool_use", "id": "call-1", "name": "http_get", "input": {"url": "https://x"}}])
    result_message = await _mk_message(
        db, session.id, "tool", "",
        content_json=[{"type": "tool_result", "tool_call_id": "call-1", "content": "ok"}])
    await _mk_message(db, session.id, "assistant", "抓到了")
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)

    # 正文只含 user/assistant 文本轮；工具气泡经配对进入 toolEvents，且只保留窗口内的
    assert [item["content"] for item in payload["messages"]] == ["帮我抓个网页", "抓到了"]
    assert len(payload["toolEvents"]) == 1
    event = payload["toolEvents"][0]
    assert event["toolCallId"] == "call-1"
    # 配对后时间线位置取「结果所在消息」，恢复窗口时才不会把工具气泡排到结果之前
    assert event["timelineOrder"] == result_message.id * 1000
