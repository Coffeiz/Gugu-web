"""Web 聊天待发队列的持久化与会话归属。"""

import pytest
from fastapi import HTTPException, Request

from app.api.v1.agent import (
    PendingQueuePatch,
    PendingQueueUpdate,
    get_pending_queue_by_id as get_pending_queue_endpoint,
    patch_session_pending_queue,
    update_draft_pending_queue,
)
from app.models import ConversationSession
from app.services import conversation_pending_queue as pending_queue_service
from app.services.conversation_pending_queue import (
    PendingQueueClaimConflict,
    bind_pending_queue,
    claim_pending_queue_item,
    get_pending_queue_by_id,
    get_pending_queue_for_session,
    patch_pending_queue,
    release_pending_queue_claim,
)


def queue_item(key: int, text: str) -> dict:
    return {"key": key, "text": text, "attachments": [], "references": []}


def _request(client_id: str = "tab-a") -> Request:
    return Request({"type": "http", "headers": [(b"x-client-id", client_id.encode())]})


@pytest.mark.asyncio
async def test_session_queue_mutation_publishes_content_free_live_event(db, user_a, monkeypatch):
    session = ConversationSession(user_id=user_a.id, title="跨端队列", source="web")
    db.add(session)
    await db.flush()
    published = {}

    async def capture_publish(user_id, *resources, **kwargs):
        published.update(user_id=user_id, resources=resources, **kwargs)
        return True

    monkeypatch.setattr(pending_queue_service.events, "publish", capture_publish)
    await patch_session_pending_queue(
        _request("browser-a"),
        f"session-{session.id}",
        PendingQueuePatch(session_id=session.id, items=[queue_item(41, "不进入事件正文")]),
        user_a,
        db,
    )

    assert published == {
        "user_id": user_a.id,
        "resources": ("pending_queues",),
        "origin": "browser-a",
        "operation": "update",
        "entity_id": session.id,
    }


@pytest.mark.asyncio
async def test_session_queue_is_saved_and_cleared_with_incremental_updates(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="队列测试", source="web")
    db.add(session)
    await db.flush()
    queue_id = f"session-{session.id}"
    result = await patch_session_pending_queue(
        _request(),
        queue_id,
        PendingQueuePatch(session_id=session.id, items=[{
            **queue_item(17, "续做刚才的分析"),
            "attachments": [{"attach_id": "attachment-1", "name": "chart.png", "_thumbUrl": "blob:ignored"}],
            "references": [{"type": "project", "id": 8, "label": "测试项目"}],
        }]),
        user_a,
        db,
    )

    assert result == {"ok": True, "count": 1}
    assert await get_pending_queue_for_session(db, user_id=user_a.id, session_id=session.id) == [{
        "key": 17,
        "session_id": session.id,
        "queue_id": queue_id,
        "claimed": False,
        "text": "续做刚才的分析",
        "attachments": [{"attach_id": "attachment-1", "name": "chart.png"}],
        "references": [{"type": "project", "id": 8, "label": "测试项目"}],
    }]

    await patch_session_pending_queue(
        _request(), queue_id,
        PendingQueuePatch(session_id=session.id, remove_keys=[17]), user_a, db,
    )
    assert await get_pending_queue_for_session(db, user_id=user_a.id, session_id=session.id) == []


@pytest.mark.asyncio
async def test_session_queue_patch_returns_success_after_persisting_items(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="队列增量写入", source="web")
    db.add(session)
    await db.flush()
    queue_id = f"session-{session.id}"

    result = await patch_session_pending_queue(
        _request(),
        queue_id,
        PendingQueuePatch(session_id=session.id, items=[queue_item(18, "增量写入")]),
        user_a,
        db,
    )

    assert result == {"ok": True, "count": 1}
    items = await get_pending_queue_for_session(db, user_id=user_a.id, session_id=session.id)
    assert [item["text"] for item in items] == ["增量写入"]


@pytest.mark.asyncio
async def test_unified_queue_read_restores_non_web_session_pending_queue(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="外部平台会话", source="qq")
    db.add(session)
    await db.flush()
    queue_id = f"session-{session.id}"

    result = await patch_session_pending_queue(
        _request(),
        queue_id,
        PendingQueuePatch(session_id=session.id, items=[queue_item(19, "从网页继续回复")]),
        user_a,
        db,
    )

    assert result == {"ok": True, "count": 1}
    restored = await get_pending_queue_endpoint(f"session-{session.id}", user_a, db)
    assert restored["sessionId"] == session.id
    assert [item["text"] for item in restored["items"]] == ["从网页继续回复"]
    assert restored["items"][0]["claimed"] is False


@pytest.mark.asyncio
async def test_session_queue_requires_its_canonical_id_and_owner(db, user_a, user_b):
    session = ConversationSession(user_id=user_a.id, title="私有会话", source="web")
    db.add(session)
    await db.flush()

    with pytest.raises(HTTPException) as wrong_owner:
        await patch_session_pending_queue(
            _request(),
            f"session-{session.id}", PendingQueuePatch(session_id=session.id), user_b, db,
        )
    assert wrong_owner.value.status_code == 404

    with pytest.raises(HTTPException) as wrong_queue:
        await patch_session_pending_queue(
            _request(),
            "old-tab-id", PendingQueuePatch(session_id=session.id), user_a, db,
        )
    assert wrong_queue.value.status_code == 409

    with pytest.raises(HTTPException) as full_replace_session_queue:
        await update_draft_pending_queue(
            f"session-{session.id}", PendingQueueUpdate(items=[]), user_a, db,
        )
    assert full_replace_session_queue.value.status_code == 409


@pytest.mark.asyncio
async def test_draft_queue_moves_to_session_and_draft_row_is_removed(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="新会话", source="web")
    db.add(session)
    await db.flush()
    draft_id = "draft-tab-123"

    await update_draft_pending_queue(
        draft_id,
        PendingQueueUpdate(items=[queue_item(2, "首轮生成时排队")]),
        user_a,
        db,
    )
    await bind_pending_queue(
        db, user_id=user_a.id, queue_id=draft_id, session_id=session.id, bind_draft_items=True,
    )
    await db.commit()

    assert await get_pending_queue_by_id(db, user_id=user_a.id, queue_id=draft_id) == (None, [])
    session_id, items = await get_pending_queue_by_id(
        db, user_id=user_a.id, queue_id=f"session-{session.id}",
    )
    assert session_id == session.id
    assert [(item["key"], item["session_id"], item["queue_id"]) for item in items] == [
        (2, session.id, f"session-{session.id}"),
    ]


@pytest.mark.asyncio
async def test_empty_new_session_does_not_create_pending_queue(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="普通消息", source="web")
    db.add(session)
    await db.flush()

    await bind_pending_queue(
        db, user_id=user_a.id, queue_id="empty-draft", session_id=session.id, bind_draft_items=True,
    )
    await db.commit()

    assert await get_pending_queue_by_id(db, user_id=user_a.id, queue_id="empty-draft") == (None, [])
    assert await get_pending_queue_for_session(db, user_id=user_a.id, session_id=session.id) == []


@pytest.mark.asyncio
async def test_queues_are_isolated_by_session_and_clearing_one_keeps_the_other(db, user_a):
    session_a = ConversationSession(user_id=user_a.id, title="会话 A", source="web")
    session_b = ConversationSession(user_id=user_a.id, title="会话 B", source="web")
    db.add_all([session_a, session_b])
    await db.flush()

    for session, key in ((session_a, 101), (session_b, 202)):
        await patch_session_pending_queue(
            _request(),
            f"session-{session.id}",
            PendingQueuePatch(session_id=session.id, items=[queue_item(key, f"发给 {key}")]),
            user_a,
            db,
        )

    await patch_session_pending_queue(
        _request(),
        f"session-{session_a.id}",
        PendingQueuePatch(session_id=session_a.id, remove_keys=[101]),
        user_a,
        db,
    )
    assert await get_pending_queue_for_session(db, user_id=user_a.id, session_id=session_a.id) == []
    items_b = await get_pending_queue_for_session(db, user_id=user_a.id, session_id=session_b.id)
    assert [(item["key"], item["session_id"]) for item in items_b] == [(202, session_b.id)]


@pytest.mark.asyncio
async def test_claim_is_exclusive_and_acknowledgment_is_atomic(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="队列接力", source="web")
    db.add(session)
    await db.flush()
    session_id = session.id
    owner_id = user_a.id
    queue_id = f"session-{session_id}"
    await patch_session_pending_queue(
        _request(),
        queue_id,
        PendingQueuePatch(session_id=session_id, items=[queue_item(31, "先发送这条"), queue_item(32, "下一条")]),
        user_a,
        db,
    )

    token = await claim_pending_queue_item(
        db, user_id=user_a.id, queue_id=queue_id, session_id=session_id, item_key=31,
    )
    assert token
    assert await claim_pending_queue_item(
        db, user_id=user_a.id, queue_id=queue_id, session_id=session_id, item_key=31,
    ) is None

    with pytest.raises(PendingQueueClaimConflict):
        await bind_pending_queue(
            db, user_id=owner_id, queue_id=queue_id, session_id=session_id,
            acknowledged_item_key=31, acknowledged_claim_token="wrong-token",
        )
    await db.rollback()

    await bind_pending_queue(
        db, user_id=owner_id, queue_id=queue_id, session_id=session_id,
        acknowledged_item_key=31, acknowledged_claim_token=token,
    )
    await db.commit()
    _, remaining = await get_pending_queue_by_id(db, user_id=owner_id, queue_id=queue_id)
    assert [item["key"] for item in remaining] == [32]


@pytest.mark.asyncio
async def test_last_acknowledged_item_removes_empty_queue(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="队列清理", source="web")
    db.add(session)
    await db.flush()
    queue_id = f"session-{session.id}"
    await patch_session_pending_queue(
        _request(),
        queue_id,
        PendingQueuePatch(session_id=session.id, items=[queue_item(33, "最后一条")]),
        user_a,
        db,
    )

    await bind_pending_queue(
        db, user_id=user_a.id, queue_id=queue_id, session_id=session.id, acknowledged_item_key=33,
    )
    await db.commit()

    assert await get_pending_queue_by_id(db, user_id=user_a.id, queue_id=queue_id) == (None, [])


@pytest.mark.asyncio
async def test_delta_updates_preserve_other_clients_items(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="并发追加", source="web")
    db.add(session)
    await db.flush()
    queue_id = f"session-{session.id}"

    for key in (5101, 5102):
        await patch_pending_queue(
            db, user_id=user_a.id, queue_id=queue_id, session_id=session.id,
            upsert_items=[queue_item(key, str(key))], remove_keys=[],
        )
    await patch_pending_queue(
        db, user_id=user_a.id, queue_id=queue_id, session_id=session.id,
        upsert_items=[], remove_keys=[5101],
    )

    _, items = await get_pending_queue_by_id(db, user_id=user_a.id, queue_id=queue_id)
    assert [item["key"] for item in items] == [5102]


@pytest.mark.asyncio
async def test_release_requires_matching_claim_token(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="释放租约", source="web")
    db.add(session)
    await db.flush()
    queue_id = f"session-{session.id}"
    await patch_pending_queue(
        db, user_id=user_a.id, queue_id=queue_id, session_id=session.id,
        upsert_items=[queue_item(61, "保留消息")], remove_keys=[],
    )
    token = await claim_pending_queue_item(
        db, user_id=user_a.id, queue_id=queue_id, session_id=session.id, item_key=61,
    )
    assert token

    assert not await release_pending_queue_claim(
        db, user_id=user_a.id, queue_id=queue_id, session_id=session.id,
        item_key=61, claim_token="wrong-token",
    )
    assert await release_pending_queue_claim(
        db, user_id=user_a.id, queue_id=queue_id, session_id=session.id,
        item_key=61, claim_token=token,
    )
