import pytest


class _Head:
    content_length = 123
    content_type = "image/png"


@pytest.mark.asyncio
async def test_validate_oss_upload_uses_server_metadata(monkeypatch):
    from app.services.files.upload import validate_oss_upload

    class _Storage:
        async def head(self, key):
            assert key == "7/image.png"
            return _Head()

    monkeypatch.setattr("app.services.files.upload.OSSStorageBackend", _Storage)
    info = await validate_oss_upload(_Storage(), 7, "7/image.png")
    assert info.size_bytes == 123
    assert info.mime_type == "image/png"


@pytest.mark.asyncio
async def test_validate_oss_upload_rejects_missing_object(monkeypatch):
    import app.services.files.upload as upload
    from app.services.files.upload import UploadTargetError, validate_oss_upload

    class _Storage:
        async def head(self, _key):
            error = RuntimeError("not found")
            error.status = 404
            raise error

    monkeypatch.setattr(upload, "OSSStorageBackend", _Storage)
    with pytest.raises(UploadTargetError, match="尚未上传"):
        await validate_oss_upload(_Storage(), 7, "7/missing.png")


@pytest.mark.asyncio
async def test_confirm_rejects_actual_size_over_single_file_limit(db, user_a):
    from app.services.files.upload import UploadTargetError, confirm_oss_upload

    with pytest.raises(UploadTargetError, match="单文件大小限制"):
        await confirm_oss_upload(
            db,
            user_a.id,
            storage_key="unused",
            display_name="large",
            ext="BIN",
            size_bytes=201 * 1024 * 1024,
            actual_mime_type="application/octet-stream",
            space="personal",
            project_id=None,
            folder_id=None,
            stage_name="",
            overwrite_file_id=None,
            storage_limit_bytes=None,
            max_file_bytes=200 * 1024 * 1024,
        )


@pytest.mark.asyncio
async def test_confirm_overwrite_rechecks_quota_with_actual_size(db, user_a):
    from app.models import File
    from app.services.files.upload import UploadTargetError, confirm_oss_upload

    existing = File(
        user_id=user_a.id,
        display_name="note",
        ext="TXT",
        space="personal",
        storage_key="existing-key",
        size="5 B",
        size_bytes=5,
        mime_type="text/plain",
    )
    db.add(existing)
    await db.commit()
    await db.refresh(existing)

    with pytest.raises(UploadTargetError, match="存储空间已满"):
        await confirm_oss_upload(
            db,
            user_a.id,
            storage_key="existing-key",
            display_name="note",
            ext="TXT",
            size_bytes=11,
            actual_mime_type="text/plain",
            space="personal",
            project_id=None,
            folder_id=None,
            stage_name="",
            overwrite_file_id=existing.id,
            storage_limit_bytes=10,
            max_file_bytes=200 * 1024 * 1024,
        )


@pytest.mark.asyncio
async def test_confirm_new_file_rechecks_quota_with_actual_size(db, user_a, monkeypatch):
    import app.services.files.upload as upload
    from app.models import File
    from app.services.files.upload import UploadTargetError, confirm_oss_upload

    monkeypatch.setattr(upload, "_build_key", lambda **kwargs: "expected-key")

    db.add(File(
        user_id=user_a.id,
        display_name="existing",
        ext="BIN",
        space="personal",
        storage_key="existing-key",
        size="9 B",
        size_bytes=9,
        mime_type="application/octet-stream",
    ))
    await db.commit()

    with pytest.raises(UploadTargetError, match="存储空间已满"):
        await confirm_oss_upload(
            db,
            user_a.id,
            storage_key="expected-key",
            display_name="new",
            ext="BIN",
            size_bytes=2,
            actual_mime_type="application/octet-stream",
            space="personal",
            project_id=None,
            folder_id=None,
            stage_name="",
            overwrite_file_id=None,
            storage_limit_bytes=10,
            max_file_bytes=200 * 1024 * 1024,
        )


@pytest.mark.asyncio
async def test_confirm_locks_user_before_quota_read(db, user_a, monkeypatch):
    """配额读取前必须锁用户行，覆盖确认不能并发突破配额。"""
    from app.services.files import upload
    from app.models import File

    statements = []
    original_execute = db.execute

    async def tracked_execute(statement, *args, **kwargs):
        statements.append(statement)
        return await original_execute(statement, *args, **kwargs)

    db.execute = tracked_execute
    monkeypatch.setattr(upload, "_build_key", lambda **kwargs: "expected-key")

    result = await upload.confirm_oss_upload(
        db,
        user_a.id,
        storage_key="expected-key",
        display_name="new",
        ext="TXT",
        size_bytes=5,
        actual_mime_type="text/plain",
        space="personal",
        project_id=None,
        folder_id=None,
        stage_name="",
        overwrite_file_id=None,
        storage_limit_bytes=100,
        max_file_bytes=200 * 1024 * 1024,
    )

    assert isinstance(result.file, File)
    assert statements[0]._for_update_arg is not None
    assert "sum" in str(statements[1]).lower()
