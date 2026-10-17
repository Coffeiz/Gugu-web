from __future__ import annotations

import hashlib
from types import SimpleNamespace

import oss2.exceptions as oss_exc

from app.services.storage import OSSStorageBackend


class _ObjectStream:
    def __init__(self, content: bytes, etag: str):
        self._content = content
        self._offset = 0
        self.etag = etag

    def read(self, size: int) -> bytes:
        chunk = self._content[self._offset:self._offset + size]
        self._offset += len(chunk)
        return chunk

    def close(self) -> None:
        return None


async def test_oss_copy_fingerprint_retries_when_source_changes_between_read_and_copy():
    backend = OSSStorageBackend.__new__(OSSStorageBackend)
    backend.bucket = SimpleNamespace(bucket_name="test-bucket")
    backend.pfx = "prefix/"
    source = {"content": b"version A", "etag": "etag-A"}
    copied: dict[str, bytes] = {}
    copy_headers: list[dict[str, str]] = []

    def get_object(key: str):
        assert key == "prefix/source"
        return _ObjectStream(source["content"], source["etag"])

    def copy_object(bucket: str, source_key: str, target_key: str, headers=None):
        assert bucket == "test-bucket"
        assert source_key == "prefix/source"
        assert target_key == "prefix/target"
        copy_headers.append(headers or {})
        if len(copy_headers) == 1:
            # 模拟摘要读取完成后、服务端复制开始前有另一个请求覆盖源对象。
            source.update(content=b"version B", etag="etag-B")
        if (headers or {}).get("x-oss-copy-source-if-match") != source["etag"]:
            raise oss_exc.PreconditionFailed(412, {}, b"", {"Code": "PreconditionFailed"})
        copied[target_key] = source["content"]

    backend.bucket.get_object = get_object
    backend.bucket.copy_object = copy_object

    fingerprint = await backend.copy_with_fingerprint("source", "target")

    assert copied["prefix/target"] == b"version B"
    assert fingerprint == hashlib.sha256(b"version B").hexdigest()
    assert copy_headers == [
        {"x-oss-copy-source-if-match": "etag-A"},
        {"x-oss-copy-source-if-match": "etag-B"},
    ]
