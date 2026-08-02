from types import SimpleNamespace

import pytest

from agent.tools import file_readers


class _Storage:
    def __init__(self, size):
        self.size = size
        self.get_called = False

    async def stat(self, key):
        return None if self.size is None else SimpleNamespace(size=self.size)

    async def get(self, key):
        self.get_called = True
        return b"media"


@pytest.mark.asyncio
async def test_media_reader_uses_physical_size_before_get(monkeypatch):
    storage = _Storage(file_readers.MEDIA_READ_MAX_BYTES + 1)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    file = SimpleNamespace(storage_key="u/media.mp4", size_bytes=0, size="0 B", ext="mp4")

    result = await file_readers.read_video(file)

    assert "超出读取上限" in result
    assert storage.get_called is False


@pytest.mark.asyncio
async def test_media_reader_rejects_missing_physical_object(monkeypatch):
    storage = _Storage(None)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    file = SimpleNamespace(storage_key="u/missing.mp3", size_bytes=1, size="1 B", ext="mp3")

    result = await file_readers.read_audio(file)

    assert "文件不存在" in result
    assert storage.get_called is False
