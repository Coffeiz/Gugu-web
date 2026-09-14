"""文件库归档 API：薄壳提交与实时事件契约。"""
from pathlib import Path

import pytest
from app.api.v1 import files as files_api
from app.core.errors import Conflict, Invalid, NotFound
from app.models import File, Folder
from app.services.files import archive as archive_service
from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path, monkeypatch):
    backend = LocalStorageBackend(Path(tmp_path))
    monkeypatch.setattr(archive_service, "get_storage", lambda: backend)
    return backend


async def _file(db, storage, user, name, content=b"archive api"):
    display_name, ext = name.rsplit(".", 1)
    key = f"{user.id}/个人文件/{name}"
    await storage.put(key, content, "application/octet-stream")
    row = File(
        user_id=user.id, display_name=display_name, ext=ext, space="personal",
        storage_key=key, size_bytes=len(content), size=f"{len(content)} B",
        mime_type="application/octet-stream",
    )
    db.add(row)
    await db.flush()
    return row


async def test_archive_api_creates_file_and_publishes_entity(db, user_a, storage, monkeypatch):
    source = await _file(db, storage, user_a, "来源.txt")
    published = []

    async def capture(*args, **kwargs):
        published.append((args, kwargs))

    monkeypatch.setattr(files_api.events, "publish", capture)
    response = await files_api.create_archive(
        files_api.ArchiveRequest(file_ids=[source.id], name="打包结果"),
        current_user=user_a, origin="browser-tab", db=db,
    )

    assert response.display_name == "打包结果"
    assert response.ext == "zip" and response.mime_type == "application/zip"
    assert len(published) == 1
    assert published[0][0][:2] == (user_a.id, "files")
    assert published[0][1]["operation"] == "create"
    assert published[0][1]["event_payload"]["entity"]["id"] == response.id


async def test_archive_api_allows_explicit_personal_root_destination(db, user_a, storage, monkeypatch):
    folder = Folder(user_id=user_a.id, project_id=None, name="来源目录")
    db.add(folder)
    await db.flush()
    source = await _file(db, storage, user_a, "来源.txt")
    source.folder_id = folder.id
    await db.flush()

    async def ignore_event(*_args, **_kwargs):
        return None

    monkeypatch.setattr(files_api.events, "publish", ignore_event)

    response = await files_api.create_archive(
        files_api.ArchiveRequest(file_ids=[source.id], folder_id=None),
        current_user=user_a, origin=None, db=db,
    )

    assert response.folder_id is None


async def test_unarchive_api_returns_created_ids_and_publishes_create(db, user_a, storage, monkeypatch):
    source = await _file(db, storage, user_a, "包.zip", b"placeholder")
    import io
    import zipfile

    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("子目录/内容.txt", "你好")
    await storage.put(source.storage_key, payload.getvalue(), "application/zip")
    source.size_bytes = len(payload.getvalue())
    source.size = f"{source.size_bytes} B"
    published = []

    async def capture(*args, **kwargs):
        published.append((args, kwargs))

    monkeypatch.setattr(files_api.events, "publish", capture)
    result = await files_api.unarchive_file(
        files_api.UnarchiveRequest(file_id=source.id),
        current_user=user_a, origin="browser-tab", db=db,
    )

    assert result["created_count"] == 2
    assert len(result["file_ids"]) == len(result["folder_ids"]) == 1
    assert await db.get(File, result["file_ids"][0]) is not None
    assert await db.get(Folder, result["folder_ids"][0]) is not None
    assert len(published) == 1
    assert published[0][1]["operation"] == "create"
    assert published[0][1]["origin"] == "browser-tab"


async def test_unarchive_api_allows_explicit_personal_root_destination(db, user_a, storage, monkeypatch):
    folder = Folder(user_id=user_a.id, project_id=None, name="来源目录")
    db.add(folder)
    await db.flush()
    source = await _file(db, storage, user_a, "包.zip")
    source.folder_id = folder.id
    import io
    import zipfile

    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("内容.txt", "你好")
    await storage.put(source.storage_key, payload.getvalue(), "application/zip")

    async def ignore_event(*_args, **_kwargs):
        return None

    monkeypatch.setattr(files_api.events, "publish", ignore_event)
    result = await files_api.unarchive_file(
        files_api.UnarchiveRequest(file_id=source.id, folder_id=None),
        current_user=user_a, origin=None, db=db,
    )

    created = await db.get(File, result["file_ids"][0])
    assert created is not None
    assert created.folder_id is None


async def test_archive_api_maps_source_limit_conflict(db, user_a, storage, monkeypatch):
    source = await _file(db, storage, user_a, "来源.txt")
    monkeypatch.setattr(archive_service, "MAX_COMPRESS_SOURCE_BYTES", 1)

    with pytest.raises(Conflict, match="内容过大"):
        await files_api.create_archive(
            files_api.ArchiveRequest(file_ids=[source.id]),
            current_user=user_a, origin=None, db=db,
        )


async def test_archive_api_hides_other_users_source_as_not_found(db, user_a, user_b, storage):
    source = await _file(db, storage, user_b, "他人.txt")

    with pytest.raises(NotFound):
        await files_api.create_archive(
            files_api.ArchiveRequest(file_ids=[source.id]),
            current_user=user_a, origin=None, db=db,
        )


async def test_unarchive_api_rejects_unsupported_format(db, user_a, storage):
    source = await _file(db, storage, user_a, "压缩包.rar")

    with pytest.raises(Invalid, match="不支持的压缩格式"):
        await files_api.unarchive_file(
            files_api.UnarchiveRequest(file_id=source.id),
            current_user=user_a, origin=None, db=db,
        )
