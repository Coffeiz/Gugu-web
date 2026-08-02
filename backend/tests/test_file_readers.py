from types import SimpleNamespace

import pytest

from agent.tools import file_readers


class _OutputStream:
    def __init__(self, chunks):
        self.chunks = list(chunks)

    async def read(self, _size=-1):
        return self.chunks.pop(0) if self.chunks else b""


class _Process:
    def __init__(self, stdout_chunks):
        self.stdout = _OutputStream(stdout_chunks)
        self.stderr = _OutputStream([])
        self.returncode = None
        self.killed = False

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


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


@pytest.mark.asyncio
async def test_ffmpeg_output_limit_kills_process(monkeypatch):
    process = _Process([b"1234", b"5678"])

    async def create_process(*_args, **_kwargs):
        return process

    monkeypatch.setattr(file_readers, "_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(file_readers.asyncio, "create_subprocess_exec", create_process)

    result = await file_readers._run_ffmpeg(b"input", "mp4", [], max_output_bytes=5)

    assert result is None
    assert process.killed is True


@pytest.mark.asyncio
async def test_media_extractors_apply_decode_limits(monkeypatch):
    calls = []

    async def run_ffmpeg(data, ext, args, max_output_bytes):
        calls.append((data, ext, args, max_output_bytes))
        return b"output"

    monkeypatch.setattr(file_readers, "_run_ffmpeg", run_ffmpeg)

    await file_readers._extract_audio(b"audio", "mp4")
    await file_readers._extract_frame(b"video", "mp4")

    audio_args = calls[0][2]
    frame_args = calls[1][2]
    assert ["-t", str(file_readers.MEDIA_AUDIO_MAX_SECONDS)] <= audio_args
    assert f"scale={file_readers.MEDIA_FRAME_MAX_WIDTH}:-2:force_original_aspect_ratio=decrease" in frame_args
    assert calls[0][3] == file_readers.MEDIA_AUDIO_MAX_OUTPUT_BYTES
    assert calls[1][3] == file_readers.MEDIA_FRAME_MAX_OUTPUT_BYTES
