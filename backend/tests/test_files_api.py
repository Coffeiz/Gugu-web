"""P0.3b file REST 端点 —— delegate 到 FileService 后端到端行为 + 响应 shape 不变。

同 test_folders_api：直接调路由函数（current_user/db/origin 显式传），不起 TestClient。
FileService(db) 内部走 get_storage()，用 monkeypatch 指向 tmp_path 本地后端；事件广播 noop。
"""
import io
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile
from sqlalchemy import select
from starlette.datastructures import Headers

from app.api.v1 import files as files_api
from app.core.errors import Invalid, NotFound
from app.models import File, Project, UndoOperation
from app.schemas import FileCopyBody, FileUpdate
from app.services.storage import LocalStorageBackend


@pytest.fixture(autouse=True)
def _storage_and_events(tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    # FileService(db) 默认 get_storage()（在 file_service 命名空间导入），指向临时本地后端
    monkeypatch.setattr("app.services.storage.file_service.get_storage", lambda: storage)
    monkeypatch.setattr(files_api, "get_storage", lambda: storage)

    async def _noop(*a, **k):
        pass
    monkeypatch.setattr(files_api.events, "publish", _noop)
    return storage


def _upload(data: bytes, filename: str, content_type: str = "text/plain") -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=filename,
                      headers=Headers({"content-type": content_type}))


async def _do_upload(db, user, data, filename, **kw):
    return await files_api.upload_file(
        BackgroundTasks(), file=_upload(data, filename, kw.pop("content_type", "text/plain")),
        current_user=user, origin=None, db=db,
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


async def test_check_conflicts_keeps_batch_response_shape(db, user_a):
    await _do_upload(db, user_a, b"1", "a.txt")
    body = files_api.ConflictCheckRequest(items=[
        files_api.ConflictCheckItem(filename="a.txt"),
        files_api.ConflictCheckItem(filename="b.txt"),
    ])
    result = await files_api.check_conflicts(body, current_user=user_a, db=db)
    assert [item["conflict"] for item in result] == [True, False]


async def test_upload_overwrite(db, user_a):
    r1 = await _do_upload(db, user_a, b"old", "a.txt")
    old_version = r1.version
    r2 = await _do_upload(db, user_a, b"newer", "a.txt",
                          on_conflict="overwrite", overwrite_file_id=r1.id)
    assert r2.id == r1.id and r2.size_bytes == 5
    assert r2.version == old_version + 1


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


async def test_download_endpoint_reads_owned_file(db, user_a):
    uploaded = await _do_upload(db, user_a, b"download-body", "report.txt")
    response = await files_api.download_file(uploaded.id, current_user=user_a, db=db)
    assert response.body == b"download-body"
    # 图片预览会反复打开同一文件，响应必须带缓存头，浏览器才能免重复下载
    assert response.headers["cache-control"] == "private, max-age=300"
    assert response.media_type == "text/plain"


# ── 分块流式上传（内存峰值与上限解耦）────────────────────────────────────────

async def test_upload_stream_writes_exact_content(db, user_a):
    r = await _do_upload(db, user_a, b"hello-stream-bytes", "流式.txt")
    assert r.size_bytes == 18
    row = (await db.execute(
        select(File).where(File.display_name == "流式")
    )).scalars().one()
    storage = files_api.get_storage()
    assert await storage.get(row.storage_key) == b"hello-stream-bytes"


async def test_upload_over_limit_rejects_without_artifacts(db, user_a, monkeypatch):
    """超限必须在收流途中拒绝：不建 File 行、不落任何存储对象。"""
    monkeypatch.setattr(files_api, "_MAX_UPLOAD_BYTES", 4)
    with pytest.raises(HTTPException) as ei:
        await _do_upload(db, user_a, b"0123456789", "大文件.txt")
    assert ei.value.status_code == 413
    assert (await db.execute(select(File))).scalars().all() == []


def _request_with_undo_context():
    # record_forward 没有 X-Undo-Context-ID 就不记撤销；直调路由时用假 request 带上。
    return SimpleNamespace(headers={"X-Undo-Context-ID": "ctx-test"})


async def test_oversized_overwrite_skips_undo_record(db, user_a, monkeypatch):
    """超过 undo 内容上限的覆盖上传：不记撤销操作（否则留存两份全量正文）。"""
    r1 = await _do_upload(db, user_a, b"old-content", "a.txt")
    monkeypatch.setattr(files_api, "_UNDO_CONTENT_MAX", 4)
    r2 = await files_api.upload_file(
        BackgroundTasks(), file=_upload(b"new-content-long", "a.txt"),
        current_user=user_a, origin=None, db=db, space="personal",
        project_id=None, folder_id=None, stage_name="", mind_map_id=None,
        on_conflict="overwrite", overwrite_file_id=r1.id,
        request=_request_with_undo_context())
    assert r2.id == r1.id
    assert (await db.execute(select(UndoOperation))).scalars().all() == []


async def test_normal_overwrite_still_records_undo(db, user_a):
    r1 = await _do_upload(db, user_a, b"old", "a.txt")
    await files_api.upload_file(
        BackgroundTasks(), file=_upload(b"new", "a.txt"),
        current_user=user_a, origin=None, db=db, space="personal",
        project_id=None, folder_id=None, stage_name="", mind_map_id=None,
        on_conflict="overwrite", overwrite_file_id=r1.id,
        request=_request_with_undo_context())
    ops = (await db.execute(select(UndoOperation))).scalars().all()
    assert len(ops) == 1


# ── 图片探针：header 直读，假图不整包进内存 ─────────────────────────────────

def _png_bytes(w=3, h=5):
    from io import BytesIO
    from PIL import Image as PILImage
    buf = BytesIO()
    PILImage.new("RGB", (w, h), (200, 10, 10)).save(buf, format="PNG")
    return buf.getvalue()


async def test_upload_real_image_gets_dimensions(db, user_a):
    body = _png_bytes(4, 7)
    await _do_upload(db, user_a, body, "真图.png", content_type="image/png")
    row = (await db.execute(
        select(File).where(File.display_name == "真图")
    )).scalars().one()
    assert (row.img_width, row.img_height) == (4, 7)


async def test_upload_fake_image_dims_none(db, user_a):
    """mime 是用户可控输入：假 PNG 探不到尺寸就 None，不能为宽高整包读。"""
    body = b"\x89PNG\r\n\x1a\n" + b"\x00" * (128 * 1024)
    r = await _do_upload(db, user_a, body, "假图.png", content_type="image/png")
    row = (await db.execute(
        select(File).where(File.display_name == "假图")
    )).scalars().one()
    assert row.img_width is None and row.img_height is None
    assert r.size_bytes == len(body)
