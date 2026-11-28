"""附件下载Python handler头部与历史脏size行为对照。"""
import asyncio
from types import SimpleNamespace
from fastapi import HTTPException
import pytest
from app.api.v1.agent_routes import attachments
from app.core import chat_attach
from app.services import storage


def test_attachment_download_headers_and_dirty_metadata_length(monkeypatch):
    raw = "合成下载".encode()
    value = dict(name="合成 文件",ext="txt",mime="text/plain",size=len(raw),storage_key="synthetic-owner/sample.txt")

    async def get_meta(owner, attach_id):
        return value if attach_id == "owned" else None

    class Storage:
        async def exists(self, key):
            return True

        async def iter_chunks(self, key):
            yield raw

    monkeypatch.setattr(chat_attach, "get_meta", get_meta)
    monkeypatch.setattr(storage, "get_storage", lambda: Storage())

    async def scenario():
        result = await attachments.attachment_download("owned", SimpleNamespace(id="synthetic-owner"))
        assert result.headers["content-length"] == "12"
        assert result.headers["content-type"] == "text/plain; charset=utf-8"
        assert result.headers["content-disposition"] == "attachment; filename*=UTF-8''%E5%90%88%E6%88%90%20%E6%96%87%E4%BB%B6.txt"
        assert result.headers["cache-control"] == "private, max-age=300"
        assert b"".join([chunk async for chunk in result.body_iterator]) == raw
        value["size"] = 1
        dirty = await attachments.attachment_download("owned", SimpleNamespace(id="synthetic-owner"))
        assert dirty.headers["content-length"] == "1"  # 记录原缺陷，Node另测真实字节长度。
        assert len(b"".join([chunk async for chunk in dirty.body_iterator])) == 12
        with pytest.raises(HTTPException) as error:
            await attachments.attachment_download("foreign", SimpleNamespace(id="synthetic-owner"))
        assert error.value.status_code == 404
    asyncio.run(scenario())
