import hashlib
import io

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile

from app.core import upload_stream


@pytest.mark.asyncio
async def test_upload_validation_reuses_multipart_stream_without_copying_body(monkeypatch):
    """大文件校验应复用 multipart 临时流，避免额外写入一份完整临时副本。"""
    payload = b"upload payload" * 100_000
    source = io.BytesIO(payload)
    upload = UploadFile(file=source, filename="fixture.bin")

    def reject_second_spool(*args, **kwargs):
        raise AssertionError("上传校验不应再分配第二个临时文件")

    monkeypatch.setattr("tempfile.SpooledTemporaryFile", reject_second_spool)

    stream, size, digest = await upload_stream.spool_upload(
        upload, limit=len(payload), status_code=413, message="too large",
    )

    assert stream is source
    assert size == len(payload)
    assert digest == hashlib.sha256(payload).hexdigest()
    assert stream.read() == payload


@pytest.mark.asyncio
async def test_upload_validation_closes_source_when_actual_stream_exceeds_limit():
    """实际流长度超限时仍拒绝，并关闭请求临时流，防止留下滚盘文件。"""
    source = io.BytesIO(b"12345")
    upload = UploadFile(file=source, filename="fixture.bin")

    with pytest.raises(HTTPException) as error:
        await upload_stream.spool_upload(
            upload, limit=4, status_code=413, message="too large",
        )

    assert error.value.status_code == 413
    assert source.closed
