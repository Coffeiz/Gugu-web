"""UI-8 Phase 4：过期操作和 artifact 清理回归。"""
from datetime import timedelta
from pathlib import Path

import pytest

from app.core.tz import now_utc
from app.services.storage import LocalStorageBackend
from app.services.undo import UndoService
from app.services.undo.files import save_content_artifacts


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
