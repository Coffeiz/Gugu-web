import re

from app.models import CalendarEvent, ConversationMessage, ConversationSession, MindNode, Project, ScheduledTask
from agent.rag.models import IndexDocument, Scope
from agent.rag.adapters.conversations import ConversationAdapter
from agent.rag.adapters.projects import ProjectAdapter
from agent.rag.index_builder import build_source_records, calendar_record
from agent.tools.conversations import _search_conversations


async def _mk(db, obj):
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


async def test_conversation_adapter_searches_owned_history_before_baseline(db, user_a, user_b, monkeypatch):
    """真实检索可按消息创建时间排序，不泄露其他用户或群聊。"""
    session = await _mk(db, ConversationSession(user_id=user_a.id, title="合成对话", baseline_message_seq=2))
    foreign = await _mk(db, ConversationSession(user_id=user_b.id, title="其他对话"))
    group = await _mk(db, ConversationSession(user_id=user_a.id, title="群聊", chat_type="group"))
    await _mk(db, ConversationMessage(session_id=session.id, role="user", content="旧消息 100%_完成", conversation_seq=1))
    await _mk(db, ConversationMessage(session_id=foreign.id, role="user", content="其他 100%_完成", conversation_seq=1))
    await _mk(db, ConversationMessage(session_id=group.id, role="user", content="群聊 100%_完成", conversation_seq=1))
    adapter = ConversationAdapter(user_a.id, db=db)
    result = await adapter.retrieve("100%_完成", scope=Scope(str(user_a.id)), strategy="bm25", candidate_limit=10)
    assert [item.document.content for item in result.results] == ["旧消息 100%_完成"]
    missing = await adapter.retrieve("100XX完成", scope=Scope(str(user_a.id)), strategy="bm25", candidate_limit=10)
    assert missing.results == ()
    # 原生分词器不是此测试的目标；在无编译扩展的环境固定词元，仍执行真实排序流程。
    monkeypatch.setattr("agent.rag.cython_rank.tokenize_raw", lambda text: re.findall(r"[a-z0-9_]+|[\u4e00-\u9fff]+", text.lower()))
    from agent.rag.service import search_conversations
    ranked = await search_conversations(db, user_a.id, "100%_完成", queries=["100%_完成"])
    assert [item["session_id"] for item in ranked["results"]] == [str(session.id)]
    assert ranked["results"][0]["text"] == "合成对话\n旧消息 100%_完成"


async def test_project_rag_source_uses_only_live_owner_projects(db, user_a, user_b):
    await _mk(db, Project(user_id=user_a.id, name="上线计划", client="小北", status="active", progress=40))
    await _mk(db, Project(user_id=user_a.id, name="归档项目", archived=True))
    await _mk(db, Project(user_id=user_b.id, name="其他项目"))
    records = await ProjectAdapter(user_a.id, db=db).build_source_records(scope=Scope(str(user_a.id)))
    assert len(records) == 1
    assert "项目：上线计划" in records[0][0]["content"]
    assert "联系人：小北" in records[0][0]["content"]


async def test_calendar_rag_record_keeps_event_fields_and_version(db, user_a):
    event = await _mk(db, CalendarEvent(user_id=user_a.id, title="合成活动", date="2026-03-01", description="活动正文"))
    record = calendar_record(event)
    assert record["id"] == str(event.id)
    assert record["time"] == ""
    assert record["description"] == "活动正文"
    assert record["version_parts"] == [str(event.id), str(event.version), event.date, event.description]


async def test_note_rag_records_keep_kind_content_and_owner(db, user_a, user_b):
    note = await _mk(db, MindNode(user_id=user_a.id, kind="note", title="便签标题", content_md="# 标题", content_plain="纯文本正文", indexed_hash="hash-a", version=2))
    await _mk(db, MindNode(user_id=user_a.id, kind="suggestion", title="建议", content_md="建议", content_plain="建议"))
    await _mk(db, MindNode(user_id=user_a.id, kind="canvas_note", title="画布", content_md="画布", content_plain="画布"))
    await _mk(db, MindNode(user_id=user_b.id, kind="note", title="其他", content_md="其他", content_plain="其他"))
    records = await build_source_records(db, user_a.id, "note")
    assert records is not None
    assert {record["kind"] for record, _ in records} == {"note", "suggestion"}
    matched = next(record for record, _ in records if record["id"] == str(note.id))
    assert matched["content_plain"] == "纯文本正文"
    assert matched["version_parts"] == [str(note.id), "2", "hash-a"]


async def test_scheduled_task_rag_records_include_event_reminders(db, user_a, user_b):
    event = await _mk(db, CalendarEvent(user_id=user_a.id, title="合成活动", date="2026-03-01"))
    await _mk(db, ScheduledTask(user_id=user_a.id, name="合成任务", payload="任务正文", cron="0 9 * * *", enabled=True))
    reminder = await _mk(db, ScheduledTask(user_id=user_a.id, event_id=event.id, name="活动提醒", payload="提醒正文", cron="0 8 * * *", enabled=False))
    await _mk(db, ScheduledTask(user_id=user_b.id, name="他人任务", payload="私有正文", cron="0 9 * * *", enabled=True))
    records = await build_source_records(db, user_a.id, "scheduled_task")
    assert records is not None
    assert {record["name"] for record, _ in records} == {"合成任务", "活动提醒"}
    item = next(record for record, _ in records if record["id"] == str(reminder.id))
    assert item["enabled"] is False
    assert item["version_parts"][2:] == ["0 8 * * *", "提醒正文"]


async def test_search_conversations_accepts_multiple_keywords(db, user_a, monkeypatch):
    """工具层多关键词契约：queries 列表原样下发，命中按会话聚合。

    worker 自读数据库（load_index_from_database）之后，写入→索引→搜索的跨进程
    全链在单测进程内不可复现（worker 子进程读不到内存 sqlite），那条链由
    worker 侧 TS 测试与 devserver e2e 覆盖；这里只锁工具协议。
    """
    session = await _mk(db, ConversationSession(user_id=user_a.id, title="部署讨论"))
    message = await _mk(db, ConversationMessage(session_id=session.id, role="user", content="上线清单"))

    captured: dict = {}

    async def fake_search(*args, **kwargs):
        captured["queries"] = kwargs.get("queries")
        return {"results": [{
            "source_id": str(message.id),
            "message_id": message.id,
            "title": session.title,
            "session_source": "web",
            "text": "上线清单",
            "role": "user",
        }]}

    monkeypatch.setattr("agent.rag.service.search_conversations", fake_search)

    result = await _search_conversations(db, user_a.id, {"queries": ["部署", "上线"]})

    assert captured["queries"] == ["部署", "上线"]
    assert [item["session_id"] for item in result["matches"]] == [session.id]
    assert result["matches"][0]["match"]["snippet"] == "上线清单"


def test_conversation_rag_result_exposes_parent_session_id():
    document = IndexDocument(
        document_id="conversation:469:18995",
        source_type="conversation",
        source_id="18995",
        scope=Scope("user-a"),
        title="你好",
        summary="",
        content="每日快讯+深度轮换+周日周报",
        version="18995",
        metadata={
            "session_id": "469",
            "message_id": 18995,
            "role": "assistant",
            "session_source": "web",
        },
    )

    result = document.as_public_result(1.0)

    assert result["session_id"] == "469"
    assert result["message_id"] == 18995
    assert result["source_id"] == "18995"


async def test_search_conversations_resolves_legacy_message_id_to_session(
    db, user_a, monkeypatch,
):
    session = await _mk(db, ConversationSession(user_id=user_a.id, title="网页对话", source="web"))
    message = await _mk(db, ConversationMessage(
        session_id=session.id, role="assistant", content="每日快讯+深度轮换+周日周报",
    ))

    async def fake_search(*args, **kwargs):
        return {"results": [{
            "source_id": str(message.id),
            "message_id": message.id,
            "title": session.title,
            "session_source": "web",
            "text": "每日快讯+深度轮换+周日周报",
            "role": "assistant",
        }]}

    monkeypatch.setattr("agent.rag.service.search_conversations", fake_search)

    result = await _search_conversations(db, user_a.id, {"query": "周报"})

    assert [item["session_id"] for item in result["matches"]] == [session.id]
