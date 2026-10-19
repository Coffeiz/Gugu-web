"""缺失文件批量确认的预览范围、并发变更与非破坏性边界。"""
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models import File, FileSyncBinding, FileSyncConflict
from app.services.filesync.missing_batch import apply_missing, preview_missing
from app.services.filesync.reconcile import _root_fingerprint


@pytest.fixture
async def batch_scope(db, user_a, tmp_path, monkeypatch):
    import app.services.filesync.admin as admin
    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol

    root = tmp_path / str(user_a.id)
    root.mkdir()
    settings = SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path), backend="local"))
    monkeypatch.setattr(bindings, "get_settings", lambda: settings)
    monkeypatch.setattr(bindings, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(admin, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(admin, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    async def deliver(*args, **kwargs):
        return None
    monkeypatch.setattr(admin, "deliver_file_event", deliver)
    binding = FileSyncBinding(user_id=user_a.id, source="local_directory", mode="bidirectional",
                              root_path=".", root_fingerprint=_root_fingerprint(root), status="active")
    db.add(binding)
    await db.flush()
    rows = []
    for name in ["missing.txt", "restored.txt", "changed.txt"]:
        file = File(user_id=user_a.id, display_name=name, ext="txt", size_bytes=0,
                    storage_key=f"{user_a.id}/{name}", version=1)
        conflict = FileSyncConflict(binding_id=binding.id, user_id=user_a.id,
                                    relative_path=name, status="pending", remote_fingerprint="a" * 64)
        db.add_all([file, conflict])
        rows.append((file, conflict))
    await db.commit()
    return binding.id, root, rows


@pytest.mark.asyncio
async def test_batch_applies_only_unchanged_missing_records(db, batch_scope):
    binding_id, root, rows = batch_scope
    preview = await preview_missing(db, binding_id)
    assert len(preview["items"]) == 3
    (root / "restored.txt").write_text("恢复后的文件", encoding="utf-8")
    rows[2][0].version += 1
    await db.commit()
    result = await apply_missing(db, binding_id, preview["rootFingerprint"], preview["items"])
    assert [item["status"] for item in result["results"]] == ["completed", "skipped", "skipped"]
    files = (await db.scalars(select(File).order_by(File.id))).all()
    assert [file.deleted_at is not None for file in files] == [True, False, False]
    assert (root / "restored.txt").read_text(encoding="utf-8") == "恢复后的文件"


@pytest.mark.asyncio
async def test_batch_refuses_replaced_root_and_foreign_preview(db, batch_scope, user_b):
    binding_id, root, rows = batch_scope
    preview = await preview_missing(db, binding_id)
    root.rename(root.with_name(root.name + "-old"))
    root.mkdir()
    with pytest.raises(ValueError, match="过期"):
        await apply_missing(db, binding_id, preview["rootFingerprint"], preview["items"])
    new_preview = await preview_missing(db, binding_id)
    foreign = File(user_id=user_b.id, display_name="foreign", ext="txt", size_bytes=0,
                   storage_key=f"{user_b.id}/foreign.txt", version=1)
    db.add(foreign)
    await db.commit()
    forged = {**new_preview["items"][0], "fileId": foreign.id}
    result = await apply_missing(db, binding_id, new_preview["rootFingerprint"], [forged])
    assert result["results"][0]["status"] == "skipped"
    await db.refresh(foreign)
    assert foreign.deleted_at is None


@pytest.mark.asyncio
async def test_batch_requires_confirmation_before_any_mutation(db):
    from fastapi import HTTPException
    from app.api.v1.filesync_admin import MissingBatchRequest, MissingPreviewItem, missing_apply

    request = MissingBatchRequest(rootFingerprint="unused", items=[MissingPreviewItem(
        conflictId=1, fileId=1, fileVersion=1, conflictRevision="unused",
    )])
    with pytest.raises(HTTPException) as error:
        await missing_apply(1, request, db)
    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_preview_excludes_live_files_and_changed_conflict_is_skipped(db, batch_scope):
    from datetime import timedelta

    binding_id, root, rows = batch_scope
    (root / "restored.txt").write_text("仍然存在", encoding="utf-8")
    preview = await preview_missing(db, binding_id)
    assert {item["relativePath"] for item in preview["items"]} == {"missing.txt", "changed.txt"}
    rows[0][1].updated_at += timedelta(seconds=1)
    await db.commit()
    result = await apply_missing(db, binding_id, preview["rootFingerprint"], [preview["items"][0]])
    assert result["results"][0]["status"] == "skipped"
    await db.refresh(rows[0][0])
    assert rows[0][0].deleted_at is None
