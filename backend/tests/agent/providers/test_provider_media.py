from types import SimpleNamespace

from agent.providers import MediaLimits, adapter_for
from agent.providers.media import DEFAULT_MEDIA_LIMITS
from agent.providers.minimax.asr import MAX_DURATION_SECONDS as ASR_MAX_DURATION_SECONDS
from agent.providers.minimax.asr import MAX_FILE_BYTES as ASR_MAX_FILE_BYTES


def test_provider_media_limits_use_shared_defaults_unless_model_has_override():
    generic = adapter_for(SimpleNamespace(provider="openai", model="gpt-test"))
    minimax = adapter_for(SimpleNamespace(provider="minimax", model="abab6.5s-chat"))

    assert generic.media_limits("gpt-test") == MediaLimits()
    assert minimax.media_limits("abab6.5s-chat") == DEFAULT_MEDIA_LIMITS


def test_minimax_m3_declares_official_direct_upload_limits():
    from agent.providers.minimax.media import M3_MEDIA_LIMITS

    adapter = adapter_for(SimpleNamespace(provider="minimax", model="MiniMax-M3"))

    limits = adapter.media_limits("MiniMax-M3")

    assert adapter.supports_video("MiniMax-M3")
    assert limits == M3_MEDIA_LIMITS
    assert limits.video_source_max_bytes == 512_000_000
    assert limits.max_duration_s == 1800
    assert not limits.duration_limit_inclusive
    assert limits.max_size_bytes == 512_000_000
    assert limits.image_max_bytes == 10_000_000
    assert limits.image_mimes == frozenset({"image/jpeg", "image/png", "image/gif", "image/webp"})
    assert limits.image_extensions == frozenset({"jpg", "jpeg", "png", "gif", "webp"})
    assert limits.preserve_image_source
    assert not limits.transcode_video
    assert not limits.transcode_video_mimes
    assert limits.video_mimes == frozenset({
        "video/mp4", "video/x-msvideo", "video/quicktime", "video/x-matroska",
    })
    assert limits.base64_max == 45 * 1024 * 1024


def test_minimax_m31_flash_uses_m3_video_capabilities_and_limits():
    model = "MiniMax-M3.1-Flash"
    adapter = adapter_for(SimpleNamespace(provider="minimax", model=model))

    assert adapter.supports_video(model)
    assert adapter.capabilities(model).image
    assert adapter.capabilities(model).video
    assert adapter.media_limits(model).max_duration_s == 1800
    assert adapter.media_limits(model).max_size_bytes == 512_000_000


def test_minimax_asr_module_owns_standalone_api_limits():
    assert ASR_MAX_FILE_BYTES == 50 * 1024 * 1024
    assert ASR_MAX_DURATION_SECONDS == 500.0


def test_mimo_native_audio_formats_are_owned_by_provider_media_module():
    from agent.providers.mimo.media import AUDIO_NATIVE_EXTS

    adapter = adapter_for(SimpleNamespace(provider="mimo", model="mimo-v2.5-pro"))

    assert adapter.audio_native_exts() == AUDIO_NATIVE_EXTS
    assert adapter.capabilities("mimo-v2.5-pro").audio
    assert adapter.capabilities("mimo-v2.5-pro").video
    responses = adapter.responses_input_capabilities(SimpleNamespace(audio=True, video=True))
    assert responses.audio_formats == AUDIO_NATIVE_EXTS
    assert responses.video
