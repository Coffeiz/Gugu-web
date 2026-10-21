"""MiniMax ASR 的格式、时长校验与 multipart 文件名契约。"""
import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from agent.providers.minimax import voice
from app.core import media_transcode
from app.services.multimodal_probe import make_silent_wav


@pytest.mark.asyncio
@pytest.mark.parametrize('mime,ext', [('audio/wav', 'wav'), ('audio/mpeg', 'mp3'), ('audio/ogg', 'ogg')])
async def test_audio_without_ext_uses_container_extension_for_probe_and_upload(monkeypatch, mime, ext):
    probed = []
    def probe(raw, actual_ext, **kwargs):
        probed.append(actual_ext)
        assert actual_ext == ext
        return 1.0
    monkeypatch.setattr(media_transcode, 'probe_duration', probe)
    post = AsyncMock(return_value=httpx.Response(200, json={'text': '识别成功'}, request=httpx.Request('POST', 'https://api.minimax.cn/v1/speech_to_text')))
    class Client:
        def __init__(self, **kwargs):
            assert kwargs['follow_redirects'] is False
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_):
            return False
    monkeypatch.setattr(Client, 'post', post, raising=False)
    monkeypatch.setattr(httpx, 'AsyncClient', Client)
    vm = SimpleNamespace(model='asr-1.0', api_key='synthetic-key', base_url='https://api.minimax.cn')
    result = await voice.transcribe([{'type': 'audio', 'mime': mime, 'b64': base64.b64encode(b'test-container').decode()}], vm, to_wav=AsyncMock(), raise_errors=True)
    assert result == '识别成功'
    assert probed == [ext]
    assert post.await_args.kwargs['files']['file'][0] == f'audio.{ext}'


@pytest.mark.asyncio
@pytest.mark.parametrize('duration', [None, 500.001])
async def test_unknown_or_excessive_duration_is_rejected_before_request(monkeypatch, duration):
    monkeypatch.setattr(media_transcode, 'probe_duration', lambda *args, **kwargs: duration)
    client = AsyncMock()
    monkeypatch.setattr(httpx, 'AsyncClient', client)
    vm = SimpleNamespace(model='asr-1.0', api_key='synthetic-key', base_url='https://api.minimax.cn')
    with pytest.raises(ValueError):
        await voice.transcribe([{'type': 'audio', 'mime': 'audio/wav', 'raw': b'test-wav'}], vm, to_wav=AsyncMock(), raise_errors=True)
    client.assert_not_called()


def test_generated_wav_without_ext_can_be_probed_with_derived_extension():
    if media_transcode._ffprobe_bin() is None:
        pytest.skip('本机没有 ffprobe，格式和校验契约由上方用例保护')
    audio = make_silent_wav(sample_rate=16000, duration_seconds=1)
    ext, mime = voice._audio_format({}, 'audio/wav')
    assert ext == 'wav'
    assert mime == 'audio/wav'
    assert media_transcode.probe_duration(audio, ext, precision=3) == 1.0
