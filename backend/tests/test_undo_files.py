"""统一撤销层 Phase 0–1：状态机、版本冲突和文件内容回滚。"""
from pathlib import Path

import pytest

from app.models import File, UndoOperation
from app.services.storage import LocalStorageBackend
from app.services.undo import UndoService
from app.services.undo.files import file_snapshot, operation_state, ref_for, save_content_artifacts
from app.services.undo.service import UndoConflict, UndoError


async def _save(db, row):
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.mark.asyncio
async def test_undo_context_preview_and_redo_branch_isolation(db, user_a, user_b):
    await UndoService.record_forward(
        db, user_id=user_a.id, context_id="tab-a", resource="files", action="create",
        target_refs=[{"kind": "file", "id": 1}], before_state={"items": {}},
        after_state={"items": {"file:1": {"version": 1}}}, base_versions={"file:1": {"version": 0}},
    )
    await UndoService.record_forward(
        db, user_id=user_b.id, context_id="tab-a", resource="files", action="create",
        target_refs=[{"kind": "file", "id": 2}], before_state={"items": {}},
        after_state={"items": {"file:2": {"version": 1}}}, base_versions={"file:2": {"version": 0}},
    )
    preview = await UndoService.preview(db, user_id=user_a.id, context_id="tab-a")
    assert preview["available"] is True
    assert preview["undo"]["target_count"] == 1
    assert preview["undo"]["operation_id"].startswith("op-")

    # context 不同的标签页只能看到自己的栈。
    other_tab = await UndoService.preview(db, user_id=user_a.id, context_id="tab-b")
    assert other_tab["available"] is False


@pytest.mark.asyncio
async def test_file_create_undo_redo_and_version_conflict(db, user_a, monkeypatch, tmp_path: Path):
    storage = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("app.services.undo.files.get_storage", lambda: storage)
    key = f"{user_a.id}/个人文件/phase1.md"
    await storage.put(key, b"old", "text/markdown")
    file = await _save(db, File(
        user_id=user_a.id, display_name="phase1", ext="md", space="personal",
        storage_key=key, size="3 KB", size_bytes=3, mime_type="text/markdown",
    ))
    ref = ref_for("file", file.id)
    op = await UndoService.record_forward(
        db, user_id=user_a.id, context_id="tab-a", resource="files", action="create",
        target_refs=[{"kind": "file", "id": file.id}], before_state=operation_state({}),
        after_state=operation_state({ref: file_snapshot(file)}),
        base_versions={ref: {"version": 0}},
    )
    await db.commit()
    result = await UndoService.apply(
        db, user_id=user_a.id, context_id="tab-a", operation_id=op.id, mode="undo",
    )
    await db.commit()
    assert result["operation"]["status"] == "undone"
    await db.refresh(file)
    assert file.deleted_at is not None

    result = await UndoService.apply(
        db, user_id=user_a.id, context_id="tab-a", operation_id=op.id, mode="redo",
    )
    await db.commit()
    await db.refresh(file)
    assert result["operation"]["status"] == "active"
    assert file.deleted_at is None

    file.version += 1
    await db.commit()
    with pytest.raises(UndoError) as error:
        await UndoService.apply(
            db, user_id=user_a.id, context_id="tab-a", operation_id=op.id, mode="undo",
        )
    assert error.value.code == "undo.conflict"


@pytest.mark.asyncio
async def test_file_content_artifact_is_not_stored_in_operation_json(db, user_a, monkeypatch, tmp_path: Path):
    storage = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("app.services.undo.files.get_storage", lambda: storage)
    file = await _save(db, File(
        user_id=user_a.id, display_name="内容", ext="md", storage_key=f"{user_a.id}/内容.md",
        size_bytes=3, size="3 KB", mime_type="text/markdown",
    ))
    ref = ref_for("file", file.id)
    op = await UndoService.record_forward(
        db, user_id=user_a.id, context_id="tab-a", resource="files", action="overwrite",
        target_refs=[{"kind": "file", "id": file.id}], before_state=operation_state({ref: file_snapshot(file)}),
        after_state=operation_state({ref: file_snapshot(file)}), base_versions={ref: {"version": 1}},
    )
    await save_content_artifacts(op, storage, user_a.id, ref, "旧正文".encode(), "新正文".encode())
    await db.commit()
    await db.refresh(op)
    assert "before_key" in op.artifact_refs[ref]
    assert "新正文" not in str(op.artifact_refs)
    assert await storage.get(op.artifact_refs[ref]["before_key"]) == "旧正文".encode()


@pytest.mark.asyncio
async def test_file_content_undo_and_redo_restore_copy_on_write_artifacts(db, user_a, monkeypatch, tmp_path: Path):
    storage = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("app.services.undo.files.get_storage", lambda: storage)
    key = f"{user_a.id}/个人文件/内容.md"
    await storage.put(key, "旧正文".encode(), "text/markdown")
    file = await _save(db, File(
        user_id=user_a.id, display_name="内容", ext="md", storage_key=key,
        size_bytes=len("旧正文".encode()), size="3 KB", mime_type="text/markdown", version=1,
    ))
    ref = ref_for("file", file.id)
    before = file_snapshot(file)
    await storage.put(key, "新正文".encode(), "text/markdown")
    file.size_bytes = len("新正文".encode())
    file.version = 2
    after = file_snapshot(file)
    op = await UndoService.record_forward(
        db, user_id=user_a.id, context_id="tab-a", resource="files", action="overwrite",
        target_refs=[{"kind": "file", "id": file.id}], before_state=operation_state({ref: before}),
        after_state=operation_state({ref: after}), base_versions={ref: {"version": 1}},
    )
    await save_content_artifacts(op, storage, user_a.id, ref, "旧正文".encode(), "新正文".encode())
    await db.commit()

    await UndoService.apply(db, user_id=user_a.id, context_id="tab-a", operation_id=op.id, mode="undo")
    await db.commit()
    assert await storage.get(key) == "旧正文".encode()
    await db.refresh(file)
    assert file.version == 3

    await UndoService.apply(db, user_id=user_a.id, context_id="tab-a", operation_id=op.id, mode="redo")
    await db.commit()
    assert await storage.get(key) == "新正文".encode()
