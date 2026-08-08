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


def _minimax_m3_ai():
    return SimpleNamespace(provider="minimax", model="abab-m3", base_url="https://api.minimaxi.com/anthropic")


def _mimo_ai():
    return SimpleNamespace(provider="mimo", model="mimo-vl", base_url="https://api.xiaomimimo.com/v1")


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
async def test_media_reader_rejects_missing_physical_object(monkeypatch):
    storage = _Storage(None)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    file = SimpleNamespace(storage_key="u/missing.mp3", size_bytes=1, size="1 B", ext="mp3")

    result = await file_readers.read_audio(file)

    assert "文件不存在" in result["error"]
    assert storage.get_called is False


# ── read_video：复用 chat_attach 的原生视频理解能力，不再降级成代表帧+ASR ────────


@pytest.mark.asyncio
async def test_read_video_returns_native_video_block_for_minimax_m3(monkeypatch):
    """核心验收：read_file 读视频最终必须产出真正的 video content block（走
    `_video_media` 特殊键，由 agent/tools/base.py dispatch 转成 tool_result 里的
    video block），而不是代表帧图片或 ASR 转写文本。"""
    storage = _Storage(90 * 1024 * 1024)  # 故意超过旧的 36MB 门禁，验证视频不再受它限制
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=_minimax_m3_ai()))

    captured_args = {}

    async def fake_prepare_video_media(raw, mime, name, model_cfg):
        captured_args["raw"] = raw
        captured_args["mime"] = mime
        captured_args["name"] = name
        captured_args["model_cfg"] = model_cfg
        return {"type": "video", "mode": "base64", "mime": "video/mp4", "b64": "ZmFrZQ=="}

    monkeypatch.setattr(file_readers.chat_attach, "prepare_video_media", fake_prepare_video_media)

    file = SimpleNamespace(storage_key="u/media.mp4", ext="mp4", id=1, display_name="clip")
    result = await file_readers.read_video(file)

    assert "_video_media" in result
    block = result["_video_media"]
    assert block == {"type": "video", "source": {"type": "base64", "media_type": "video/mp4", "data": "ZmFrZQ=="}}
    assert "_vision_image" not in result
    assert "content" not in result
    assert captured_args["raw"] == b"media"
    assert captured_args["mime"] == "video/mp4"
    assert captured_args["model_cfg"] is not None


@pytest.mark.asyncio
async def test_read_video_rejects_when_provider_not_minimax_m3(monkeypatch):
    """视频 tool_result 只有 Anthropic 通道（MiniMax M3）能承载原生 video block——
    其它 provider 明确返回不支持，而不是退化成代表帧/ASR 这类近似方案。"""
    storage = _Storage(1024)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=_mimo_ai()))

    file = SimpleNamespace(storage_key="u/media.mp4", ext="mp4", id=1, display_name="clip")
    result = await file_readers.read_video(file)

    assert "不支持" in result["error"]
    assert storage.get_called is False   # 能力不够时不该白读一次文件


@pytest.mark.asyncio
async def test_read_video_missing_file(monkeypatch):
    storage = _Storage(None)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=_minimax_m3_ai()))

    file = SimpleNamespace(storage_key="u/missing.mp4", ext="mp4", id=1, display_name="clip")
    result = await file_readers.read_video(file)

    assert "不存在" in result["error"]


@pytest.mark.asyncio
async def test_read_video_propagates_prepare_video_media_rejection(monkeypatch):
    """>90MB / mm_file 上传失败等场景，prepare_video_media 抛 ValueError——
    read_video 必须原样把这个明确的拒绝理由返回给用户，而不是吞掉改成通用错误。"""
    storage = _Storage(95 * 1024 * 1024)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=_minimax_m3_ai()))

    async def fake_prepare_video_media(raw, mime, name, model_cfg):
        raise ValueError("这条视频太大（超过 90MB 上限），没法直接看")

    monkeypatch.setattr(file_readers.chat_attach, "prepare_video_media", fake_prepare_video_media)

    file = SimpleNamespace(storage_key="u/media.mp4", ext="mp4", id=1, display_name="clip")
    result = await file_readers.read_video(file)

    assert result == {"error": "这条视频太大（超过 90MB 上限），没法直接看"}


@pytest.mark.asyncio
async def test_read_video_generic_failure_returns_generic_error(monkeypatch):
    storage = _Storage(1024)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=_minimax_m3_ai()))

    async def boom(raw, mime, name, model_cfg):
        raise RuntimeError("ffmpeg 挂了")

    monkeypatch.setattr(file_readers.chat_attach, "prepare_video_media", boom)

    file = SimpleNamespace(storage_key="u/media.mp4", ext="mp4", id=1, display_name="clip")
    result = await file_readers.read_video(file)

    assert result == {"error": "视频读取失败"}
