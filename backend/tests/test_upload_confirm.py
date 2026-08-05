import pytest


class _Head:
    content_length = 123
    content_type = "image/png"


@pytest.mark.asyncio
async def test_validate_oss_upload_uses_server_metadata(monkeypatch):
    from app.services.files.upload import validate_oss_upload

    key = "7/.upload-staging/abc123.png"

    class _Storage:
        async def head(self, k):
            assert k == key
            return _Head()

    monkeypatch.setattr("app.services.files.upload.OSSStorageBackend", _Storage)
    info = await validate_oss_upload(_Storage(), 7, key)
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
        await validate_oss_upload(_Storage(), 7, "7/.upload-staging/missing.png")


@pytest.mark.asyncio
async def test_validate_oss_upload_rejects_non_staging_key(monkeypatch):
    """客户端把自己名下一个正式文件的 storage_key 当 staging_key 传回来，必须直接
    拒绝——不能让后面的 rename_file 把这个真实对象移走（P1 复查 blocker 1）。"""
    import app.services.files.upload as upload
    from app.services.files.upload import UploadTargetError, validate_oss_upload

    head_called = []

    class _Storage:
        async def head(self, key):
            head_called.append(key)
            return _Head()

    monkeypatch.setattr(upload, "OSSStorageBackend", _Storage)

    for bad_key in (
        "7/个人文件/existing.png",           # 同一用户名下的正式文件 key
        "8/.upload-staging/abc123.png",       # 别的用户的 staging key
        "7-evil/.upload-staging/abc123.png",  # 前缀数字拼接绕过（"7" + 任意后缀）
    ):
        with pytest.raises(UploadTargetError, match="无权限"):
            await validate_oss_upload(_Storage(), 7, bad_key)

    assert head_called == []   # 路径校验必须在真的去读 OSS 之前就拦下


@pytest.mark.asyncio
async def test_confirm_rejects_actual_size_over_single_file_limit(db, user_a):
    from app.services.files.upload import UploadTargetError, confirm_oss_upload

    with pytest.raises(UploadTargetError, match="单文件大小限制"):
        await confirm_oss_upload(
            db,
            user_a.id,
            None,   # 单文件超限在碰 storage 之前就会抛，不需要真实 storage
            staging_key=f"{user_a.id}/.upload-staging/unused.bin",
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
            None,   # 配额超限在碰 storage 之前就会抛，不需要真实 storage
            staging_key=f"{user_a.id}/.upload-staging/x.txt",
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
            None,   # 配额超限在碰 storage 之前就会抛，不需要真实 storage
            staging_key=f"{user_a.id}/.upload-staging/x.bin",
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

    staging_key = f"{user_a.id}/.upload-staging/x.txt"

    class _Storage:
        async def rename_file(self, old_key, new_key):
            assert old_key == staging_key
            assert new_key == "expected-key"

    result = await upload.confirm_oss_upload(
        db,
        user_a.id,
        _Storage(),
        staging_key=staging_key,
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
    assert result.file.storage_key == "expected-key"
    assert statements[0]._for_update_arg is not None
    assert "sum" in str(statements[1]).lower()


@pytest.mark.asyncio
async def test_presign_signs_staging_key_not_final_or_existing_key(db, user_a, monkeypatch):
    """presign 不能直接对最终 key（含覆盖场景已有文件的 storage_key）签 PUT——
    浏览器一 PUT 就会让 OSS 立即覆盖真实数据，早于任何服务端校验。"""
    from app.models import File
    from app.services.files.upload import presign_upload_url, prepare_presign_target

    class _Storage:
        pass

    monkeypatch.setattr("app.services.files.upload.OSSStorageBackend", _Storage)

    existing = File(
        user_id=user_a.id, display_name="note", ext="TXT", space="personal",
        storage_key="existing-key", size="5 B", size_bytes=5, mime_type="text/plain",
    )
    db.add(existing)
    await db.commit()
    await db.refresh(existing)

    target = await prepare_presign_target(
        db, _Storage(), user_a.id, "note.txt", 11, "personal", None, None,
        "overwrite", existing.id, None,
    )

    assert target.final_key == "existing-key"
    assert target.staging_key != "existing-key"
    assert target.staging_key.startswith(f"{user_a.id}/.upload-staging/")

    signed = []

    class _SignStorage(_Storage):
        def presign_put(self, key, mime_type=None, expires=600):
            signed.append(key)
            return f"https://signed/{key}"

    url = await presign_upload_url(_SignStorage(), target, "text/plain")
    assert signed == [target.staging_key]
    assert url == f"https://signed/{target.staging_key}"


@pytest.mark.asyncio
async def test_confirm_overwrite_copies_to_new_key_and_returns_old_key(db, user_a):
    """覆盖上传落地到全新的版本 key，不复用旧 key；旧 key 只在返回值里交给调用方，
    由调用方在 DB commit 成功后再删——confirm 本身不碰旧的物理对象。"""
    from app.models import File
    from app.services.files.upload import confirm_oss_upload

    existing = File(
        user_id=user_a.id, display_name="note", ext="TXT", space="personal",
        storage_key="existing-key", size="5 B", size_bytes=5, mime_type="text/plain",
    )
    db.add(existing)
    await db.commit()
    await db.refresh(existing)

    renamed = []
    staging_key = f"{user_a.id}/.upload-staging/x.txt"

    class _Storage:
        async def rename_file(self, old_key, new_key):
            renamed.append((old_key, new_key))

    result = await confirm_oss_upload(
        db,
        user_a.id,
        _Storage(),
        staging_key=staging_key,
        display_name="note",
        ext="TXT",
        size_bytes=9,
        actual_mime_type="text/plain",
        space="personal",
        project_id=None,
        folder_id=None,
        stage_name="",
        overwrite_file_id=existing.id,
        storage_limit_bytes=None,
        max_file_bytes=200 * 1024 * 1024,
    )

    assert renamed == [(staging_key, result.file.storage_key)]
    assert result.file.storage_key != "existing-key"
    assert result.old_storage_key == "existing-key"
    assert result.file.size_bytes == 9


@pytest.mark.asyncio
async def test_confirm_oss_upload_rejects_non_staging_key_without_calling_rename(db, user_a):
    """confirm_oss_upload 自己也要挡一遍非 staging key（防御性冗余，不完全依赖调用方
    先调过 validate_oss_upload）——新建文件路径。"""
    from app.services.files.upload import UploadTargetError, confirm_oss_upload

    class _Storage:
        async def rename_file(self, old_key, new_key):
            raise AssertionError("不应该调用 rename_file")

    with pytest.raises(UploadTargetError, match="无权限"):
        await confirm_oss_upload(
            db,
            user_a.id,
            _Storage(),
            staging_key=f"{user_a.id}/个人文件/existing.png",   # 正式文件 key，不是 staging key
            display_name="new",
            ext="PNG",
            size_bytes=5,
            actual_mime_type="image/png",
            space="personal",
            project_id=None,
            folder_id=None,
            stage_name="",
            overwrite_file_id=None,
            storage_limit_bytes=None,
            max_file_bytes=200 * 1024 * 1024,
        )


@pytest.mark.asyncio
async def test_confirm_oss_upload_overwrite_rejects_non_staging_key_without_calling_rename(db, user_a):
    """覆盖上传同样不能用非 staging key，防止把别的正式文件顶替进覆盖目标。"""
    from app.models import File
    from app.services.files.upload import UploadTargetError, confirm_oss_upload

    existing = File(
        user_id=user_a.id, display_name="note", ext="TXT", space="personal",
        storage_key="existing-key", size="5 B", size_bytes=5, mime_type="text/plain",
    )
    db.add(existing)
    await db.commit()
    await db.refresh(existing)

    class _Storage:
        async def rename_file(self, old_key, new_key):
            raise AssertionError("不应该调用 rename_file")

    with pytest.raises(UploadTargetError, match="无权限"):
        await confirm_oss_upload(
            db,
            user_a.id,
            _Storage(),
            staging_key=f"{user_a.id}/个人文件/other.png",   # 别的正式文件 key
            display_name="note",
            ext="TXT",
            size_bytes=9,
            actual_mime_type="text/plain",
            space="personal",
            project_id=None,
            folder_id=None,
            stage_name="",
            overwrite_file_id=existing.id,
            storage_limit_bytes=None,
            max_file_bytes=200 * 1024 * 1024,
        )


@pytest.mark.asyncio
async def test_validate_oss_upload_rejects_reused_staging_key_after_first_confirm(monkeypatch):
    """同一个 staging key 用过一次（rename_file 会把它删掉）后，第二次 confirm 必须
    失败——staging 对象已经不存在了，HEAD 会 404。"""
    from app.services.files.upload import UploadTargetError, validate_oss_upload

    key = "7/.upload-staging/reused.png"
    call_count = {"n": 0}

    class _Storage:
        async def head(self, k):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return _Head()
            error = RuntimeError("not found")
            error.status = 404
            raise error

    monkeypatch.setattr("app.services.files.upload.OSSStorageBackend", _Storage)
    storage = _Storage()

    first = await validate_oss_upload(storage, 7, key)
    assert first.size_bytes == 123

    # 第一次 confirm 之后 rename_file 会把 staging 对象删掉（本测试只模拟 HEAD 行为，
    # 不实际调 rename_file），第二次再用同一个 key 就该拿到"尚未上传"的错误。
    with pytest.raises(UploadTargetError, match="尚未上传"):
        await validate_oss_upload(storage, 7, key)
