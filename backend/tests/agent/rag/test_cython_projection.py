"""保护迁移期 Python source projection 的文档身份、正文与隔离边界。"""
from __future__ import annotations

import hashlib

from agent.rag.cython_projection import project_source_records
from agent.rag.models import Scope


OWNER = "owner-fixture"
OWNER_SCOPE = Scope(owner_user_id=OWNER)


def _record(source_type: str, record: dict, scope: Scope = OWNER_SCOPE):
    return project_source_records(OWNER, source_type, [(record, scope)])


def test_generic_projection_keeps_stable_chunk_identity_version_and_summary() -> None:
    record = {
        "id": "entry-1", "source_type": "knowledge", "title": "缓存规则",
        "summary": "检索提示", "content": "正文内容", "source_id": "source-1",
        "parent_id": "knowledge-parent", "version_parts": ["entry-1", 7],
        "metadata": {"confidence": "confirmed"},
    }

    documents = _record("knowledge", record)

    assert len(documents) == 1
    document = documents[0]
    assert (document.document_id, document.parent_document_id, document.chunk_index) == (
        "knowledge-parent", "knowledge-parent", 0,
    )
    assert document.source_id == "source-1"
    assert document.title == "缓存规则"
    assert document.summary == "检索提示"
    assert document.content == "正文内容"
    assert document.version == hashlib.sha256("entry-1\x1f7\x1f正文内容".encode()).hexdigest()[:16]
    assert document.metadata == {"confidence": "confirmed"}


def test_generic_projection_uses_record_source_type_and_nullish_source_id_fallback() -> None:
    documents = _record("memory", {
        "id": "entry-2", "source_type": "project", "title": "项目记录",
        "content": "项目正文", "source_id": None,
    })

    assert len(documents) == 1
    document = documents[0]
    assert document.source_type == "project"
    assert document.document_id == "project:entry-2"
    assert document.source_id == "entry-2"


def test_note_projection_prefers_plain_text_and_indexes_title_with_body() -> None:
    documents = _record("note", {
        "id": 7, "title": "会议结论", "content_plain": "采用新方案",
        "content_md": "不应使用的 Markdown", "kind": "note",
        "version_parts": [7, 3, "hash"],
    })

    assert documents[0].content == "会议结论\n采用新方案"
    assert documents[0].source_id == "7"
    assert documents[0].metadata == {"node_id": "7", "kind": "note"}


def test_canvas_projection_preserves_relation_and_project_metadata() -> None:
    documents = _record("canvas", {
        "id": 12, "canvas_id": 2, "canvas_title": "路线图", "node_id": 9,
        "node_title": "检索", "node_type": "text", "content": "实施步骤",
        "group_path": "阶段一", "relation_summary": "检索 → 排序", "project_id": 41,
        "version_parts": [12, "updated", 4],
    })

    document = documents[0]
    assert document.title == "路线图 · 检索"
    assert document.content == "画布：路线图\n节点：检索\n类型：text\n分组：阶段一\n关系：检索 → 排序\n实施步骤"
    assert document.metadata["project_id"] == "41"
    assert document.metadata["relation_summary"] == "检索 → 排序"


def test_calendar_and_scheduled_task_projection_keep_fixed_headers() -> None:
    calendar = _record("calendar", {
        "id": 3, "title": "评审", "date": "2026-10-30", "time": "",
        "description": "确认范围", "project_id": 8,
    })[0]
    scheduled = _record("scheduled_task", {
        "id": 5, "name": "日报", "cron": "0 9 * * *", "enabled": False,
        "payload": "总结昨日进度",
    })[0]

    assert calendar.content == "活动：评审\n日期：2026-10-30\n时间：全天\n确认范围"
    assert calendar.metadata == {"event_id": "3", "project_id": "8"}
    assert scheduled.content == "定时任务：日报\n计划：0 9 * * *\n状态：停用\n总结昨日进度"
    assert scheduled.metadata == {"task_id": "5", "enabled": False}


def test_conversation_projection_keeps_message_role_and_neighbor_context() -> None:
    document = _record("conversation", {
        "id": 77, "kind": "message", "session_id": 22, "role": "user",
        "content": "查一下缓存", "context_before": "assistant：我来看看",
        "context_after": "assistant：已找到", "title": "检索会话",
        "session_source": "web", "session_updated_at": "updated",
    })[0]

    assert document.document_id == "conversation:77"
    assert document.content == "user：查一下缓存"
    assert document.summary == ""
    assert document.contextual_content() == "assistant：我来看看\nuser：查一下缓存\nassistant：已找到"
    assert document.metadata["message_id"] == "77"
    assert document.metadata["session_id"] == "22"


def test_projection_rejects_cross_owner_and_incomplete_group_scope() -> None:
    record = {"id": "m1", "source_type": "memory", "title": "记忆", "content": "正文"}
    documents = project_source_records(OWNER, "memory", [
        (record, Scope(owner_user_id="other-owner")),
        (record, Scope(owner_user_id=OWNER, scope_type="group", group_id="")),
    ])

    assert documents == []


def test_long_unicode_projection_uses_worker_codepoint_chunk_size_and_overlap() -> None:
    content = "字" * 3000
    documents = _record("memory", {
        "id": "long", "source_type": "memory", "title": "表情",
        "content": content,
    })

    assert [len(document.content) for document in documents] == [1000, 1000, 1000, 450]
    assert documents[0].content[-150:] == documents[1].content[:150]
    assert documents[1].content[-150:] == documents[2].content[:150]
    assert documents[2].content[-150:] == documents[3].content[:150]
    assert [document.chunk_index for document in documents] == [0, 1, 2, 3]
    assert all(document.chunk_count == 4 for document in documents)


def test_chunking_prefers_sentence_and_paragraph_boundaries() -> None:
    content = "第一句。第二句！\n\n第三句？第四句；尾句。"
    documents = _record("memory", {
        "id": "boundaries", "source_type": "memory", "title": "边界",
        "content": content,
    })

    assert [document.content for document in documents] == [
        "第一句。\n第二句！\n第三句？\n第四句；\n尾句。",
    ]


def test_chunking_counts_astral_characters_as_single_codepoints() -> None:
    content = "😀" * 3000
    documents = _record("memory", {
        "id": "astral", "source_type": "memory", "title": "表情",
        "content": content,
    })

    assert [len(document.content) for document in documents] == [1000, 1000, 1000, 450]
    assert documents[0].content[-150:] == documents[1].content[:150]
    assert documents[-1].content == content[-450:]


def test_chunking_never_splits_an_astral_codepoint_at_budget_boundary() -> None:
    content = "a" * 999 + "😀" + "b" * 20
    documents = _record("memory", {
        "id": "surrogate-boundary", "source_type": "memory", "title": "边界",
        "content": content,
    })

    assert len(documents) == 2
    assert documents[0].content == "a" * 999 + "😀"
    assert documents[1].content.startswith("a" * 149 + "😀")
    assert "\ud83d" not in documents[0].content


def test_projection_version_hash_matches_node_utf8_replacement_for_lone_surrogate() -> None:
    """TS Node crypto 将孤立代理项替换为 U+FFFD，Python 投影必须产出同一版本。"""
    content = "正文\ud800尾部"
    document = _record("memory", {
        "id": "surrogate-version", "source_type": "memory", "title": "边界",
        "content": content, "version_parts": ["record"],
    })[0]
    expected_payload = "record\x1f正文\ufffd尾部"

    assert document.version == hashlib.sha256(expected_payload.encode("utf-8")).hexdigest()[:16]
