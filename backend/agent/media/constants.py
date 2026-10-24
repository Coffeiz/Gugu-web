"""媒体域常量：MIME 映射、视觉处理参数与 Provider 媒体策略的默认别名。

媒体域只关心「媒体本身长什么样」——文件类型分型（这是不是图片/音频/视频）归附件域
（`app/core/chat_attach/file_types.py`），本模块不重复定义那套集合。
"""
from __future__ import annotations

from agent.providers.media import MediaLimits

# 视频与音频的 Provider 限制由 `ProviderAdapter.media_limits()` 提供。
# 下列常量仅为旧调用方保留默认策略别名；运行时决策直接使用 Provider 策略。
_DEFAULT_MEDIA_LIMITS = MediaLimits()
VIDEO_SOURCE_MAX = _DEFAULT_MEDIA_LIMITS.video_source_max_bytes
VIDEO_DURATION_MAX_SECONDS = _DEFAULT_MEDIA_LIMITS.max_duration_s
VIDEO_COMPRESS_MAX_DIM = _DEFAULT_MEDIA_LIMITS.compress_max_dim
VIDEO_COMPRESS_BITRATE = _DEFAULT_MEDIA_LIMITS.compress_bitrate
VIDEO_COMPRESS_TRIGGER_BITRATE = _DEFAULT_MEDIA_LIMITS.compress_trigger_bitrate
VIDEO_BASE64_MAX = _DEFAULT_MEDIA_LIMITS.base64_max
VIDEO_MMFILE_MAX = _DEFAULT_MEDIA_LIMITS.max_size_bytes
VIDEO_MMFILE_PURPOSE = "video_understanding"   # Files API 上传 purpose

MEDIA_RAW_MAX = 36 * 1024 * 1024   # 原始字节上限：base64 后约 <50MB（mimo base64 限制）

MEDIA_MIME = {
    "mp3": "audio/mpeg", "wav": "audio/wav", "flac": "audio/flac", "m4a": "audio/mp4", "ogg": "audio/ogg",
    "mp4": "video/mp4", "mov": "video/quicktime", "avi": "video/x-msvideo", "wmv": "video/x-ms-wmv",
    "mkv": "video/x-matroska",
}

# 哪些图片格式 API 原生收、达标可免重编码（其余 heic/bmp/tiff… 一律重编码成 JPEG）
VISION_PASSTHROUGH = frozenset({"png", "jpg", "jpeg", "gif", "webp"})
VISION_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
               "gif": "image/gif", "webp": "image/webp"}
VISION_IMG_MAX = 5 * 1024 * 1024   # 单张图喂模型的字节上限（超了自动降采样压缩，不再直接丢）
VISION_MAX_DIM = 3840              # 喂模型前长边降采样到此像素，保留高分辨率细节
VISION_TARGET_BYTES = 8 * 1024 * 1024  # 压缩目标字节（留 API 余量）
IMAGE_READ_MAX = 30 * 1024 * 1024   # read_file 看图时从存储拉取的硬上限（压缩前），挡住超大文件
