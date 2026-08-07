from pathlib import Path
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
    """默认模拟本地存储：local_path 直接给一个假路径（不落盘、不流式下载）。"""

    def __init__(self, size, *, local=True):
        self.size = size
        self.get_called = False
        self.download_called = False
        self._local = local

    async def stat(self, key):
        return None if self.size is None else SimpleNamespace(size=self.size)

    async def get(self, key):
        self.get_called = True
        return b"media"

    def local_path(self, key):
        return Path("/tmp/fake-local-video.mp4") if self._local else None

    async def download_to_file(self, key, dest):
        self.download_called = True
        dest.write_bytes(b"media")


@pytest.mark.asyncio
async def test_media_reader_uses_physical_size_before_get(monkeypatch):
    """read_audio 超限直接拒绝、不下载。"""
    storage = _Storage(file_readers.MEDIA_READ_MAX_BYTES + 1)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    file = SimpleNamespace(storage_key="u/media.mp3", size_bytes=0, size="0 B", ext="mp3")

    result = await file_readers.read_audio(file)

    assert "超出读取上限" in result["error"]
    assert storage.get_called is False


@pytest.mark.asyncio
async def test_read_video_succeeds_via_direct_ffmpeg_extraction(monkeypatch):
    """核心回归：超过 MEDIA_READ_MAX_BYTES 的视频不再被拒绝——不压缩、不整段进内存，
    直接对物化后的磁盘文件跑 ffmpeg 提取画面+音频，最终返回真正可用的读取结果。"""
    storage = _Storage(file_readers.MEDIA_READ_MAX_BYTES + 1, local=True)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)

    extract_calls = []

    async def fake_extract_frame(source):
        extract_calls.append(("frame", source))
        return b"frame-bytes"

    async def fake_extract_audio(source):
        extract_calls.append(("audio", source))
        return b"audio-bytes"

    async def fake_transcribe(raw, mime):
        assert raw == b"audio-bytes"
        return "音频转写文本"

    monkeypatch.setattr(file_readers, "_extract_frame", fake_extract_frame)
    monkeypatch.setattr(file_readers, "_extract_audio", fake_extract_audio)
    monkeypatch.setattr(file_readers, "_transcribe_audio", fake_transcribe)
    monkeypatch.setattr(file_readers.chat_attach, "vision_ready", lambda: False)

    file = SimpleNamespace(storage_key="u/media.mov", size_bytes=0, size="0 B", ext="mov", id=1, display_name="clip")
    result = await file_readers.read_video(file)

    # 视频本身超过 MEDIA_READ_MAX_BYTES 也不再报错——真正验证了用户报告的场景已修复。
    assert "content" in result
    assert "音频转写文本" in result["content"]
    assert extract_calls[0][0] == "frame"
    assert extract_calls[1][0] == "audio"
    # 本地存储走零拷贝路径，没有下载到临时文件。
    assert storage.download_called is False


@pytest.mark.asyncio
async def test_read_video_downloads_remote_storage_to_temp_file(monkeypatch, tmp_path):
    """OSS 等远程后端没有 local_path，必须流式下载到临时文件，而不是整段读进内存。"""
    storage = _Storage(file_readers.MEDIA_READ_MAX_BYTES + 1, local=False)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)

    seen_paths = []

    async def fake_extract_frame(source):
        seen_paths.append(source)
        assert source.exists()
        return b"frame-bytes"

    async def fake_extract_audio(source):
        seen_paths.append(source)
        return None

    monkeypatch.setattr(file_readers, "_extract_frame", fake_extract_frame)
    monkeypatch.setattr(file_readers, "_extract_audio", fake_extract_audio)
    monkeypatch.setattr(file_readers.chat_attach, "vision_ready", lambda: False)

    file = SimpleNamespace(storage_key="u/media.mp4", size_bytes=0, size="0 B", ext="mp4", id=2, display_name="clip2")
    await file_readers.read_video(file)

    assert storage.download_called is True
    assert storage.get_called is False, "不应该再走整段 get() 读进内存"
    # 提取完成后临时文件应已清理。
    assert not seen_paths[0].exists()


@pytest.mark.asyncio
async def test_media_reader_rejects_missing_physical_object(monkeypatch):
    storage = _Storage(None)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    file = SimpleNamespace(storage_key="u/missing.mp3", size_bytes=1, size="1 B", ext="mp3")

    result = await file_readers.read_audio(file)

    assert "文件不存在" in result["error"]
    assert storage.get_called is False


@pytest.mark.asyncio
async def test_ffmpeg_output_limit_kills_process(monkeypatch, tmp_path):
    process = _Process([b"1234", b"5678"])

    async def create_process(*_args, **_kwargs):
        return process

    monkeypatch.setattr(file_readers, "_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(file_readers.asyncio, "create_subprocess_exec", create_process)

    result = await file_readers._run_ffmpeg(tmp_path / "input.mp4", [], max_output_bytes=5)

    assert result is None
    assert process.killed is True


@pytest.mark.asyncio
async def test_media_extractors_apply_decode_limits(monkeypatch, tmp_path):
    calls = []

    async def run_ffmpeg(source, args, max_output_bytes):
        calls.append((source, args, max_output_bytes))
        return b"output"

    monkeypatch.setattr(file_readers, "_run_ffmpeg", run_ffmpeg)

    source = tmp_path / "input.mp4"
    await file_readers._extract_audio(source)
    await file_readers._extract_frame(source)

    audio_args = calls[0][1]
    frame_args = calls[1][1]
    assert ["-t", str(file_readers.MEDIA_AUDIO_MAX_SECONDS)] <= audio_args
    assert f"scale={file_readers.MEDIA_FRAME_MAX_WIDTH}:-2:force_original_aspect_ratio=decrease" in frame_args
    assert calls[0][2] == file_readers.MEDIA_AUDIO_MAX_OUTPUT_BYTES
    assert calls[1][2] == file_readers.MEDIA_FRAME_MAX_OUTPUT_BYTES
