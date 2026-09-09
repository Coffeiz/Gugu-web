"""UI-8 Phase 4：历史摘要、统计、过期操作和 artifact 清理回归。"""
from datetime import timedelta
from pathlib import Path

import pytest

from app.core.tz import now_utc
from app.services.storage import LocalStorageBackend
from app.services.undo import UndoService
from app.services.undo.files import save_content_artifacts


@pytest.mark.asyncio
async def test_undo_history_is_scoped_and_does_not_expose_snapshots(db, user_a, user_b):
    first = await UndoService.record_forward(
        db, user_id=user_a.id, context_id="phase4-tab", resource="files", action="update",
        target_refs=[{"kind": "file", "id": 1}],
        before_state={"items": {"file:1": {
            "content": "绝不应进入可见摘要的正文",
            "credential": "fake-token-for-test",
            "host_path": "/Users/example/private.txt",
        }}},
        after_state={"items": {"file:1": {"version": 2}}}, base_versions={},
        artifact_refs={"file:1": {"before_key": "private-artifact-key"}},
    )
    await UndoService.record_forward(
        db, user_id=user_b.id, context_id="phase4-tab", resource="files", action="delete",
        target_refs=[{"kind": "file", "id": 2}], before_state={}, after_state={}, base_versions={},
    )
    await db.commit()

    history = await UndoService.history(db, user_id=user_a.id, context_id="phase4-tab")
    assert [item["operation_id"] for item in history] == [first.id]
    rendered = str(history)
    assert "绝不应进入可见摘要的正文" not in rendered
    assert "fake-token-for-test" not in rendered
    assert "/Users/example/private.txt" not in rendered
    assert "private-artifact-key" not in rendered
    assert history[0]["can_undo"] is True

    stats = await UndoService.stats(db, user_id=user_a.id, context_id="phase4-tab")
    assert stats == {"total": 1, "by_status": {"active": 1, "undone": 0, "conflicted": 0, "failed": 0, "expired": 0}}


@pytest.mark.asyncio
async def test_expired_undo_cleanup_removes_artifacts_and_marks_operation(db, user_a, tmp_path: Path):
    storage = LocalStorageBackend(tmp_path)
    operation = await UndoService.record_forward(
        db, user_id=user_a.id, context_id="phase4-cleanup", resource="files", action="overwrite",
        target_refs=[{"kind": "file", "id": 1}], before_state={}, after_state={}, base_versions={},
    )
    await save_content_artifacts(operation, storage, user_a.id, "file:1", b"before", b"after")
    operation.expires_at = now_utc() - timedelta(seconds=1)
    await db.commit()

    result = await UndoService.cleanup_expired(db, storage=storage)
    await db.commit()
    await db.refresh(operation)
    assert result["expired"] == 1
    assert result["artifacts"] == 2
    assert operation.status == "expired"
    assert operation.artifact_refs == {}
    assert await storage.list_keys() == []
