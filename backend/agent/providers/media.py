"""Provider 多模态输入规格的共享类型与默认策略。"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MediaLimits:
    """Provider 媒体输入限制与预处理策略。

    默认值维持通用模型的现有行为；Provider 只声明其接口明确要求的差异。
    """

    audio_max_bytes: int = 36 * 1024 * 1024
    video_source_max_bytes: int = 500 * 1024 * 1024
    max_duration_s: int | None = 120
    duration_limit_inclusive: bool = True
    max_size_bytes: int = 90 * 1024 * 1024
    image_max_bytes: int | None = None
    image_mimes: frozenset[str] = frozenset()
    image_extensions: frozenset[str] = frozenset()
    preserve_image_source: bool = False
    transcode_video: bool = True
    video_mimes: frozenset[str] = frozenset()
    compress_max_dim: int = 1920
    compress_bitrate: str = "5M"
    compress_trigger_bitrate: int = 16 * 1024 * 1024
    transcode_video_mimes: frozenset[str] = frozenset()
    base64_max: int = 45 * 1024 * 1024
    inline_max_bytes: int = 36 * 1024 * 1024


DEFAULT_MEDIA_LIMITS = MediaLimits()
