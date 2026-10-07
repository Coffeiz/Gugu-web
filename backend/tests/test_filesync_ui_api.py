"""用户文件同步面板读取的健康状态契约。"""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.api.v1 import filesync


@pytest.mark.asyncio
async def test_user_binding_snapshot_includes_watcher_and_manual_reconcile_state(
    monkeypatch, user_a,
):
    binding = SimpleNamespace(
        id=9,
        user_id=user_a.id,
        source="local_directory",
        mode="bidirectional",
        root_path=".",
        status="active",
        revision=12,
        watcher_status="ready",
        needs_reconcile=True,
        health_revision=7,
        gap_revision=4,
        health_error_code=None,
        last_reconciled_at=datetime(2026, 10, 6, tzinfo=timezone.utc),
    )
    list_bindings = AsyncMock(return_value=[binding])
    monkeypatch.setattr(filesync, "list_user_bindings", list_bindings)
    db = object()

    result = await filesync.bindings(user=user_a, db=db)

    list_bindings.assert_awaited_once_with(db, user_a.id)
    assert result == [{
        "id": 9,
        "source": "local_directory",
        "mode": "bidirectional",
        "rootPath": ".",
        "status": "active",
        "revision": 12,
        "watcherStatus": "ready",
        "needsReconcile": True,
        "healthRevision": 7,
        "gapRevision": 4,
        "healthErrorCode": None,
        "lastReconciledAt": "2026-10-06T00:00:00+00:00",
    }]
