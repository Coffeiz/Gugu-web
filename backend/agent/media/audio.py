"""音频时长探测与 Provider 规格校验。"""
from __future__ import annotations

import asyncio
import math

from agent.media.errors import MediaPreflightError


def native_audio_extensions(model_cfg) -> frozenset[str]:
    """返回本轮实际主模型和协议共同支持的音频扩展名。"""
    from agent import providers
    from agent.media import gates
    if model_cfg is None:
        from app.core.config import get_settings
        model_cfg = get_settings().ai

    if not gates.audio_enabled(model_cfg):
        return frozenset()
    return frozenset(
        str(ext).lower().lstrip(".")
        for ext in providers.adapter_for(model_cfg).audio_native_exts()
    )


async def probe_audio_duration(raw: bytes, ext: str | None) -> float | None:
    """非阻塞地探测音频容器时长；探测失败返回 None。"""
    from app.core.media_transcode import probe_duration

    return await asyncio.to_thread(probe_duration, raw, ext, precision=3)


async def preflight_duration(
    raw: bytes, ext: str | None, max_duration_s: float | None, provider_label: str,
) -> float | None:
    """对已声明时长上限的音频探测并校验；未知限制不猜测。"""
    if max_duration_s is None:
        return None
    duration = await probe_audio_duration(raw, ext)
    check_audio_duration(duration, max_duration_s, provider_label)
    return duration


def check_audio_duration(duration: float | None, max_duration_s: float, provider_label: str) -> None:
    """时长未知或超过明确限制时，在请求 Provider 前拒绝音频。"""
    if duration is None or not math.isfinite(float(duration)) or duration <= 0:
        raise MediaPreflightError(
            "无法确认音频时长，未发送到语音识别服务；请检查媒体文件或 ffprobe"
        )
    if duration > max_duration_s:
        raise MediaPreflightError(
            f"音频时长 {duration:g} 秒，超过当前 {provider_label} 的 "
            f"{max_duration_s:g} 秒上限，未发送到识别服务"
        )
