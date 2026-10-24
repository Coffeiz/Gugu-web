"""MiMo 模型原生多模态输入规格。"""
from __future__ import annotations

from ..base import ResponsesInputCapabilities, configured_responses_input_capabilities


AUDIO_NATIVE_EXTS = frozenset({"mp3", "wav", "flac", "m4a", "ogg"})
NATIVE_AUDIO_SUPPORTED = True
NATIVE_VIDEO_SUPPORTED = True


def supports_audio_model(model: str = "") -> bool:
    """MiMo 模型支持原生音频输入。"""
    return NATIVE_AUDIO_SUPPORTED


def supports_video_model(model: str = "") -> bool:
    """MiMo 模型支持原生视频输入。"""
    return NATIVE_VIDEO_SUPPORTED


def responses_input_capabilities(ai) -> ResponsesInputCapabilities:
    """返回 MiMo Responses API 的原生音频、视频输入规格。"""
    return configured_responses_input_capabilities(
        ai,
        audio_formats=AUDIO_NATIVE_EXTS if supports_audio_model() else frozenset(),
        supports_video=supports_video_model(),
    )
