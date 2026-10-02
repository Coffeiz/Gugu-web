"""多模态能力探测的共享媒体样本、Provider 请求与错误脱敏回归。"""
import base64
import io
import wave

import pytest

from agent import providers
from app.services import multimodal_probe


class _Messages:
    def __init__(self, error=None):
        self.error = error
        self.request = None

    async def create(self, **request):
        self.request = request
        if self.error:
            raise self.error
        return object()


class _AnthropicClient:
    def __init__(self, error=None):
        self.messages = _Messages(error)
        self.closed = False

    async def close(self):
        self.closed = True


class _ProviderError(Exception):
    status_code = 400


_TARGET = multimodal_probe.MultimodalProbeTarget(
    provider="minimax", api_key="probe-key", base_url="https://api.minimax.example/anthropic",
    model="MiniMax-M3", api_format="anthropic",
)


def test_silent_wav_sample_builder_supports_probe_and_voice_test_profiles():
    short = multimodal_probe.make_silent_wav(sample_rate=8000, duration_seconds=0.1)
    voice_test = multimodal_probe.make_silent_wav(sample_rate=16000, duration_seconds=1)

    with wave.open(io.BytesIO(short), "rb") as wav:
        assert wav.getframerate() == 8000
        assert wav.getnframes() == 800
    with wave.open(io.BytesIO(voice_test), "rb") as wav:
        assert wav.getframerate() == 16000
        assert wav.getnframes() == 16000


@pytest.mark.asyncio
async def test_minimax_image_probe_sends_anthropic_image_block_and_closes_client(monkeypatch):
    client = _AnthropicClient()
    captured = {}

    def build_client(target, timeout):
        captured.update(target=target, timeout=timeout)
        return client

    monkeypatch.setattr(providers, "build_anthropic_client", build_client)

    result = await multimodal_probe.probe_multimodal_capability(_TARGET, dim="image")

    assert result[0] is True
    assert captured["target"] is _TARGET
    content = client.messages.request["messages"][0]["content"]
    image_block = next(block for block in content if block["type"] == "image")
    assert image_block["source"]["media_type"] == "image/png"
    assert base64.b64decode(image_block["source"]["data"]).startswith(b"\x89PNG\r\n\x1a\n")
    assert client.closed is True


@pytest.mark.asyncio
async def test_multimodal_probe_redacts_provider_error_before_returning_it(monkeypatch):
    secret = "sk-12345678901234567890"
    client = _AnthropicClient(_ProviderError(f"invalid media; api_key={secret}"))
    monkeypatch.setattr(providers, "build_anthropic_client", lambda *_args: client)

    supported, status, detail = await multimodal_probe.probe_multimodal_capability(_TARGET, dim="image")

    assert supported is None
    assert status == 400
    assert secret not in detail
    assert "密钥已隐藏" in detail
    assert client.closed is True


@pytest.mark.asyncio
async def test_minimax_m3_anthropic_video_uses_shared_declared_capability(monkeypatch):
    def unexpected_request(*_args, **_kwargs):
        raise AssertionError("已登记的 MiniMax M3 视频能力不应重复探测")

    monkeypatch.setattr(providers, "build_anthropic_client", unexpected_request)

    supported, status, detail = await multimodal_probe.probe_multimodal_capability(_TARGET, dim="video")

    assert supported is True
    assert status == 200
    assert "MiniMax M3" in detail


@pytest.mark.asyncio
async def test_responses_image_probe_uses_native_image_input(monkeypatch):
    client = _AnthropicClient()
    client.responses = client.messages
    monkeypatch.setattr(providers, "build_openai_client", lambda *_args: client)
    target = multimodal_probe.MultimodalProbeTarget(
        provider="openai", api_key="probe-key", base_url="https://example.com/v1",
        model="probe-model", api_format="responses")
    supported, status, _ = await multimodal_probe.probe_multimodal_capability(target)
    assert supported is True and status == 200
    request = client.responses.request
    assert "messages" not in request
    image = request["input"][0]["content"][1]
    assert image["type"] == "input_image"
    assert image["image_url"].startswith("data:image/png;base64,")
    assert client.closed


@pytest.mark.asyncio
@pytest.mark.parametrize("dim", ["audio", "video"])
async def test_unverified_responses_media_probe_does_not_test_chat_or_deny_capability(monkeypatch, dim):
    def unexpected_client(*args):
        raise AssertionError("未知 Responses 媒体格式不得切到 Chat 探测")
    monkeypatch.setattr(providers, "build_openai_client", unexpected_client)
    target = multimodal_probe.MultimodalProbeTarget(
        provider="openai", api_key="probe-key", base_url="https://example.com/v1",
        model="probe-model", api_format="responses")
    supported, _, _ = await multimodal_probe.probe_multimodal_capability(target, dim=dim)
    assert supported is None
