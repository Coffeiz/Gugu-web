"""P0.3b file REST 端点 —— delegate 到 FileService 后端到端行为 + 响应 shape 不变。

同 test_folders_api：直接调路由函数（current_user/db/origin 显式传），不起 TestClient。
FileService(db) 内部走 get_storage()，用 monkeypatch 指向 tmp_path 本地后端；事件广播 noop。
"""
import io
from pathlib import Path

import pytest
from fastapi import BackgroundTasks, UploadFile
from starlette.datastructures import Headers

from app.api.v1 import files as files_api
from app.core.errors import Invalid, NotFound
from app.models import Project
from app.schemas import FileCopyBody, FileUpdate
from app.services.storage import LocalStorageBackend


@pytest.fixture(autouse=True)
def _storage_and_events(tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    # FileService(db) 默认 get_storage()（在 file_service 命名空间导入），指向临时本地后端
    monkeypatch.setattr("app.services.storage.file_service.get_storage", lambda: storage)

    async def _noop(*a, **k):
        pass
    monkeypatch.setattr(files_api.events, "publish", _noop)
    return storage


def _upload(data: bytes, filename: str, content_type: str = "text/plain") -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=filename,
                      headers=Headers({"content-type": content_type}))


async def _do_upload(db, user, data, filename, **kw):
    return await files_api.upload_file(
        BackgroundTasks(), file=_upload(data, filename), current_user=user, origin=None, db=db,
        space=kw.pop("space", "personal"), project_id=kw.pop("project_id", None),
        folder_id=kw.pop("folder_id", None), stage_name=kw.pop("stage_name", ""),
        mind_map_id=kw.pop("mind_map_id", None), on_conflict=kw.pop("on_conflict", "keep_both"),
        overwrite_file_id=kw.pop("overwrite_file_id", None))


async def test_upload_endpoint(db, user_a):
    r = await _do_upload(db, user_a, b"hello", "报告.pdf")
    assert r.display_name == "报告" and r.ext == "PDF" and r.space == "personal"
    assert r.size_bytes == 5


async def test_upload_keep_both_conflict(db, user_a):
    await _do_upload(db, user_a, b"1", "a.txt")
    r2 = await _do_upload(db, user_a, b"2", "a.txt")
    assert r2.display_name == "a(1)"


async def test_upload_overwrite(db, user_a):
    r1 = await _do_upload(db, user_a, b"old", "a.txt")
    r2 = await _do_upload(db, user_a, b"newer", "a.txt",
                          on_conflict="overwrite", overwrite_file_id=r1.id)
    assert r2.id == r1.id and r2.size_bytes == 5


async def test_upload_project_shapes_response(db, user_a):
    p = Project(user_id=user_a.id, name="设计", start_date="2026-03-15")
    db.add(p)
    await db.commit()
    await db.refresh(p)
    r = await _do_upload(db, user_a, b"x", "图.png", space="project", project_id=p.id)
    assert r.project_id == p.id and r.project_name == "设计"


async def test_upload_project_not_found(db, user_a):
    with pytest.raises(Invalid):
        await _do_upload(db, user_a, b"x", "a.txt", space="project", project_id=999)


async def test_patch_rename_endpoint(db, user_a):
    up = await _do_upload(db, user_a, b"1", "old.txt")
    r = await files_api.update_file(up.id, FileUpdate(display_name="new"),
                                    current_user=user_a, origin=None, db=db)
    assert r.display_name == "new"


async def test_patch_not_found(db, user_a):
    with pytest.raises(NotFound):
        await files_api.update_file(999, FileUpdate(display_name="x"),
                                    current_user=user_a, origin=None, db=db)


async def test_copy_endpoint(db, user_a):
    up = await _do_upload(db, user_a, b"body", "doc.txt")
    r = await files_api.copy_file(up.id, FileCopyBody(folder_id=None, project_id=None),
                                  current_user=user_a, origin=None, db=db)
    assert r.id != up.id and r.display_name == "doc(1)"


async def test_copy_not_found(db, user_a):
    with pytest.raises(NotFound):
        await files_api.copy_file(999, FileCopyBody(folder_id=None, project_id=None),
                                  current_user=user_a, origin=None, db=db)
