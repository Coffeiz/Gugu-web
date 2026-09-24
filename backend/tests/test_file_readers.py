from types import SimpleNamespace

import pytest

from app.core import chat_attach
from agent.tools import media_reader as file_readers, media_reader


class _Storage:
    def __init__(self, size, data=b"media"):
        self.size = size
        self.data = data
        self.get_called = False

    async def stat(self, key):
        return None if self.size is None else SimpleNamespace(size=self.size)

    async def get(self, key):
        self.get_called = True
        return self.data


def _minimax_m3_ai():
    return SimpleNamespace(provider="minimax", model="abab-m3", base_url="https://api.minimaxi.com/anthropic",
                           vision_video=True)


def _mimo_ai():
    return SimpleNamespace(provider="mimo", model="mimo-vl", base_url="https://api.xiaomimimo.com/v1")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reader", "physical_size", "data", "read_expected"),
    [
        ("audio", file_readers.MEDIA_READ_MAX_BYTES + 1, b"media", False),
        ("image", chat_attach.VISION_READ_MAX + 1, b"media", False),
        ("image", 5, b"x" * (chat_attach.VISION_READ_MAX + 1), True),
    ],
)
async def test_media_readers_enforce_physical_and_actual_size(
    monkeypatch, reader, physical_size, data, read_expected
):
    """音频和图片先查物理大小，并防止 stat/get 之间文件变大绕过限制。"""
    storage = _Storage(physical_size, data)
    if reader == "audio":
        monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
        file = SimpleNamespace(storage_key="u/media.mp3", size_bytes=0, size="0 B", ext="mp3")
        result = await file_readers.read_audio(file)
        assert "超出读取上限" in result["error"]
    else:
        monkeypatch.setattr("app.services.storage.get_storage", lambda: storage)
        monkeypatch.setattr(chat_attach, "vision_ready", lambda: True)
        monkeypatch.setattr(media_reader, "get_storage", lambda: storage)
        result = await media_reader.read_stored_image("u/image.png", "png")
        assert "过大" in result["error"]
    assert storage.get_called is read_expected


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
    `_media_block` 特殊键，由 agent/tools/base.py dispatch 转成 tool_result 里的
    video block），而不是代表帧图片或 ASR 转写文本。"""
    storage = _Storage(90 * 1024 * 1024)  # 故意超过旧的 36MB 门禁，验证视频不再受它限制
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=_minimax_m3_ai()))

    captured_args = {}

    async def fake_prepare_video_media(raw, mime, name, model_cfg, **kwargs):
        captured_args["raw"] = raw
        captured_args["mime"] = mime
        captured_args["name"] = name
        captured_args["model_cfg"] = model_cfg
        return {"type": "video", "mode": "base64", "mime": "video/mp4", "b64": "ZmFrZQ=="}

    monkeypatch.setattr(file_readers.chat_attach, "prepare_video_media", fake_prepare_video_media)

    file = SimpleNamespace(storage_key="u/media.mp4", ext="mp4", id=1, display_name="clip", user_id="u1")
    result = await file_readers.read_video(file)

    assert "_media_block" in result
    block = result["_media_block"]
    assert block == {"type": "video", "source": {"type": "base64", "media_type": "video/mp4", "data": "ZmFrZQ=="}}
    assert "_vision_image" not in result
    assert "content" not in result
    assert captured_args["raw"] == b"media"
    assert captured_args["mime"] == "video/mp4"
    assert captured_args["model_cfg"] is not None


@pytest.mark.asyncio
async def test_read_video_supports_openai_compatible_video_model(monkeypatch):
    """支持视频输入的 OpenAI 兼容模型直接接收 video_url 块，不限于 MiniMax。"""
    storage = _Storage(1024)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    ai = _mimo_ai()
    ai.vision_video = True
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=ai))

    async def fake_prepare_video_media(raw, mime, name, model_cfg, **kwargs):
        return {"type": "video", "mode": "base64", "mime": "video/mp4", "b64": "ZmFrZQ=="}

    monkeypatch.setattr(file_readers.chat_attach, "prepare_video_media", fake_prepare_video_media)

    file = SimpleNamespace(storage_key="u/media.mp4", ext="mp4", id=1, display_name="clip", user_id="u1")
    result = await file_readers.read_video(file)

    assert result["_media_block"]["type"] == "video_url"
    assert "data:video/mp4;base64,ZmFrZQ==" in result["_media_block"]["video_url"]["url"]
    assert storage.get_called is True


@pytest.mark.asyncio
async def test_read_video_rejects_responses_protocol_before_loading_file(monkeypatch):
    storage = _Storage(1024)
    ai = _mimo_ai()
    ai.vision_video = True
    ai.api_format = "responses"
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=ai))
    file = SimpleNamespace(storage_key="u/media.mp4", ext="mp4", id=1, display_name="clip")

    result = await file_readers.read_video(file)

    assert "API 协议" in result["error"]
    assert storage.get_called is False


@pytest.mark.asyncio
async def test_read_video_missing_file(monkeypatch):
    storage = _Storage(None)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=_minimax_m3_ai()))

    file = SimpleNamespace(storage_key="u/missing.mp4", ext="mp4", id=1, display_name="clip")
    result = await file_readers.read_video(file)

    assert "不存在" in result["error"]


@pytest.mark.asyncio
async def test_read_video_rejects_over_500mb_without_reading_full_bytes(monkeypatch):
    """源文件超过 VIDEO_SOURCE_MAX 时，用 stat() 已经拿到的物理大小直接拒绝，
    不应该再去 get() 把整个文件读进内存——stat() 通常只是一次元信息查询，
    没必要为了一个注定要拒绝的超大视频先申请等量内存（code review 指出）。"""
    storage = _Storage(600 * 1024 * 1024)   # 600MB，超过 VIDEO_SOURCE_MAX(500MB)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=_minimax_m3_ai()))

    file = SimpleNamespace(storage_key="u/media.mp4", ext="mp4", id=1, display_name="clip", user_id="u1")
    result = await file_readers.read_video(file)

    assert "500MB" in result["error"]
    assert storage.get_called is False


@pytest.mark.asyncio
async def test_read_video_propagates_prepare_video_media_rejection(monkeypatch):
    """>90MB / mm_file 上传失败等场景，prepare_video_media 抛 ValueError——
    read_video 必须原样把这个明确的拒绝理由返回给用户，而不是吞掉改成通用错误。"""
    storage = _Storage(95 * 1024 * 1024)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=_minimax_m3_ai()))

    async def fake_prepare_video_media(raw, mime, name, model_cfg, **kwargs):
        raise ValueError("这条视频太大（超过 90MB 上限），没法直接看")

    monkeypatch.setattr(file_readers.chat_attach, "prepare_video_media", fake_prepare_video_media)

    file = SimpleNamespace(storage_key="u/media.mp4", ext="mp4", id=1, display_name="clip", user_id="u1")
    result = await file_readers.read_video(file)

    assert result == {"error": "这条视频太大（超过 90MB 上限），没法直接看"}


@pytest.mark.asyncio
async def test_read_video_generic_failure_returns_generic_error(monkeypatch):
    storage = _Storage(1024)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=_minimax_m3_ai()))

    async def boom(raw, mime, name, model_cfg, **kwargs):
        raise RuntimeError("ffmpeg 挂了")

    monkeypatch.setattr(file_readers.chat_attach, "prepare_video_media", boom)

    file = SimpleNamespace(storage_key="u/media.mp4", ext="mp4", id=1, display_name="clip", user_id="u1")
    result = await file_readers.read_video(file)

    assert result == {"error": "视频读取失败"}


@pytest.mark.asyncio
async def test_read_video_uses_running_model_cfg_not_static_settings(monkeypatch):
    """pool/router 场景下，settings.ai（顶层静态配置）可能和这轮真正执行的模型不是
    同一个——read_video 判断能力/生成 video block 必须用 agent.llm.modelctx 里这轮真正
    在跑的 model_cfg，不能重新读 get_settings().ai（否则会出现"顶层配 MiniMax、这轮
    实际跑 mimo，却按 MiniMax 生成 Anthropic video block"这类错配）。这里反过来验证：
    settings.ai 是不支持视频的 mimo，但本轮 modelctx 里真正跑的是 MiniMax M3，
    read_video 必须按 modelctx 判断为"支持"，而不是被 settings.ai 误判为"不支持"。"""
    from agent.llm import modelctx

    storage = _Storage(1024)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    # 顶层静态配置指向不支持视频的 provider——如果 read_video 错误地读了这个就会
    # 判定"不支持"，测试会失败。
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=_mimo_ai()))

    captured = {}

    async def fake_prepare_video_media(raw, mime, name, model_cfg, **kwargs):
        captured["model_cfg"] = model_cfg
        return {"type": "video", "mode": "base64", "mime": "video/mp4", "b64": "ZmFrZQ=="}

    monkeypatch.setattr(file_readers.chat_attach, "prepare_video_media", fake_prepare_video_media)

    real_ai = _minimax_m3_ai()
    token = modelctx._model_cfg.set(real_ai)
    try:
        file = SimpleNamespace(storage_key="u/media.mp4", ext="mp4", id=1, display_name="clip", user_id="u1")
        result = await file_readers.read_video(file)
    finally:
        modelctx._model_cfg.reset(token)

    assert "_media_block" in result
    assert captured["model_cfg"] is real_ai


@pytest.mark.asyncio
async def test_read_audio_prefers_native_audio_when_enabled(monkeypatch):
    storage = _Storage(1024, b"audio")
    ai = SimpleNamespace(provider="mimo", model="mimo-v2.5-pro", base_url="https://api.xiaomimimo.com/v1",
                         vision_audio=True)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=ai))

    async def should_not_transcribe(*args):
        raise AssertionError("native audio must not fall back to ASR")

    monkeypatch.setattr(file_readers, "_transcribe_audio", should_not_transcribe)
    file = SimpleNamespace(storage_key="u/audio.mp3", ext="mp3", id=2, display_name="recording")

    result = await file_readers.read_audio(file)

    assert result["_media_block"]["type"] == "input_audio"
    assert result["_media_block"]["input_audio"]["data"].startswith("data:audio/mpeg;base64,")


@pytest.mark.asyncio
async def test_read_audio_falls_back_to_asr_when_native_audio_is_disabled(monkeypatch):
    storage = _Storage(1024, b"audio")
    ai = SimpleNamespace(provider="mimo", model="mimo-v2.5-pro", base_url="https://api.xiaomimimo.com/v1",
                         vision_audio=False)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=ai))
    async def transcribe(*_):
        return "转写内容"

    monkeypatch.setattr(file_readers, "_transcribe_audio", transcribe)
    file = SimpleNamespace(storage_key="u/audio.mp3", ext="mp3", id=2, display_name="recording")

    result = await file_readers.read_audio(file)

    assert result["content"] == "转写内容"
    assert "_media_block" not in result


@pytest.mark.asyncio
@pytest.mark.parametrize(("api_format", "ext"), [("responses", "mp3"), ("", "aac")])
async def test_read_audio_falls_back_when_protocol_or_format_is_unsupported(monkeypatch, api_format, ext):
    storage = _Storage(1024, b"audio")
    ai = SimpleNamespace(provider="mimo", model="mimo-v2.5-pro", base_url="https://api.xiaomimimo.com/v1",
                         vision_audio=True, api_format=api_format)
    monkeypatch.setattr(file_readers, "get_storage", lambda: storage)
    monkeypatch.setattr(file_readers, "get_settings", lambda: SimpleNamespace(ai=ai))
    async def transcribe(*_):
        return "转写内容"

    monkeypatch.setattr(file_readers, "_transcribe_audio", transcribe)
    file = SimpleNamespace(storage_key=f"u/audio.{ext}", ext=ext, id=2, display_name="recording")

    result = await file_readers.read_audio(file)

    assert result["content"] == "转写内容"
