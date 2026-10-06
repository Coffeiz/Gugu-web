"""单文件预览入口同时提供元数据与地址，且保持删除和用户隔离边界。"""

import pytest
from fastapi import HTTPException

from app.api.v1 import files as files_api
from app.core.tz import now_utc
from app.models import File
from app.schemas import FileStreamResponse


async def test_stream_preview_returns_single_file_metadata(db, user_a, monkeypatch):
    row = File(
        user_id=user_a.id, display_name="预览样例", ext="PNG",
        storage_key="synthetic/preview.png", size_bytes=12, version=3,
    )
    db.add(row)
    await db.commit()

    async def stream_url(*args, **kwargs):
        return "/synthetic/preview-stream"

    monkeypatch.setattr(files_api, "get_storage", lambda: object())
    monkeypatch.setattr(files_api, "build_stream_url", stream_url)
    result = FileStreamResponse.model_validate(
        await files_api.get_stream_url(row.id, current_user=user_a, db=db)
    )
    assert result.file.id == row.id
    assert result.file.display_name == "预览样例"
    assert result.file.version == 3
    assert result.url == "/synthetic/preview-stream"


@pytest.mark.parametrize("deleted", [False, True])
async def test_stream_preview_rejects_foreign_or_deleted_files(
    db, user_a, user_b, monkeypatch, deleted,
):
    row = File(
        user_id=user_a.id if deleted else user_b.id,
        display_name="隔离样例", ext="TXT", storage_key="synthetic/private.txt",
        deleted_at=now_utc() if deleted else None,
    )
    db.add(row)
    await db.commit()

    def forbidden_storage():
        pytest.fail("拒绝访问的文件不能生成存储地址")

    monkeypatch.setattr(files_api, "get_storage", forbidden_storage)
    with pytest.raises(HTTPException) as error:
        await files_api.get_stream_url(row.id, current_user=user_a, db=db)
    assert error.value.status_code == 404
