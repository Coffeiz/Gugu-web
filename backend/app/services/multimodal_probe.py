"""共享的 LLM 图片、音频和视频能力探测。"""
from __future__ import annotations

import asyncio
import base64
import inspect
import io
import os
import shutil
import struct
import subprocess
import tempfile
import wave
import zlib
from dataclasses import dataclass

import httpx

from agent import providers
from app.core.redaction import diag_log, redact


@dataclass(frozen=True)
class MultimodalProbeTarget:
    """同一次探测的模型连接参数；不包含任何持久化行为。"""

    provider: str
    api_key: str
    base_url: str
    model: str
    api_format: str = ""


def make_silent_wav(*, sample_rate: int, duration_seconds: float) -> bytes:
    """生成短静音 WAV，供多模态探针和语音连通测试共用。"""
    frame_count = int(sample_rate * duration_seconds)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\x00\x00" * frame_count)
    return buffer.getvalue()


def _probe_png_b64() -> str:
    """纯 stdlib 生成 64×64 实色 PNG，满足常见视觉接口的最小尺寸要求。"""
    width = height = 64
    row = b"\x00" + b"\xe0\x40\x40" * width
    image_data = zlib.compress(row * height)

    def _chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)

    png = (b"\x89PNG\r\n\x1a\n"
           + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
           + _chunk(b"IDAT", image_data)
           + _chunk(b"IEND", b""))
    return base64.b64encode(png).decode()


_PROBE_MP4_B64_CACHE: str | None = None


def _probe_mp4_b64() -> str:
    """用 ffmpeg 生成短动态 MP4，供需要真实视频输入块的 OpenAI 兼容接口探测。"""
    global _PROBE_MP4_B64_CACHE
    if _PROBE_MP4_B64_CACHE is not None:
        return _PROBE_MP4_B64_CACHE
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg 未安装，无法生成视频探测样本")
    fd, temp_path = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    try:
        command = [ffmpeg, "-y", "-loglevel", "error",
                   "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
                   "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", temp_path]
        process = subprocess.run(command, capture_output=True, timeout=30)
        if process.returncode != 0:
            raise RuntimeError(f"ffmpeg 生成探测视频失败：{process.stderr.decode(errors='ignore')[:200]}")
        with open(temp_path, "rb") as stream:
            data = stream.read()
    finally:
        try:
            os.remove(temp_path)
        except OSError as exc:
            diag_log("multimodal_probe.remove_temp_video", exc)
    if not data:
        raise RuntimeError("ffmpeg 生成的探测视频为空")
    _PROBE_MP4_B64_CACHE = base64.b64encode(data).decode()
    return _PROBE_MP4_B64_CACHE


def _known_capability_result(adapter, model: str, is_anthropic: bool,
                              dim: str, dim_label: str) -> tuple[bool, int, str] | None:
    """返回由协议适配器明确登记的媒体能力结论；未知能力交给真实探测。"""
    if dim == "video" and is_anthropic:
        if adapter.supports_video(model):
            return True, 200, "MiniMax M3 原生支持视频块"
        return False, 200, "Anthropic 路当前仅 MiniMax M3 支持视频块"
    if not is_anthropic and dim in ("video", "audio"):
        if (dim == "video" and adapter.supports_video(model)) or (
            dim == "audio" and adapter.supports_audio(model)
        ):
            return True, 200, f"MiMo 原生支持{dim_label}输入"
    return None


def _anthropic_content(dim: str) -> list[dict] | None:
    if dim == "image":
        return [
            {"type": "text", "text": "这张图是什么颜色？用一个词回答。"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                             "data": _probe_png_b64()}},
        ]
    if dim == "audio":
        audio_b64 = base64.b64encode(make_silent_wav(sample_rate=8000, duration_seconds=0.1)).decode()
        return [
            {"type": "text", "text": "这段音频说了什么？用一个词回答。"},
            {"type": "input_audio", "source": {"type": "base64", "media_type": "audio/wav",
                                                   "data": audio_b64}},
        ]
    return None


async def _openai_content(dim: str) -> tuple[list[dict] | None, str | None]:
    if dim == "image":
        return [
            {"type": "text", "text": "这张图是什么颜色？用一个词回答。"},
            {"type": "image_url", "image_url": {
                "url": f"data:image/png;base64,{_probe_png_b64()}", "detail": "auto"}},
        ], None
    if dim == "video":
        try:
            video_b64 = await asyncio.to_thread(_probe_mp4_b64)
        except RuntimeError as exc:
            return None, f"无法生成视频探测样本：{redact(str(exc))}"
        return [
            {"type": "text", "text": "这段视频里发生了什么？用一个词回答。"},
            {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{video_b64}"},
             "fps": 2},
        ], None
    if dim == "audio":
        audio_b64 = base64.b64encode(make_silent_wav(sample_rate=8000, duration_seconds=0.1)).decode()
        return [
            {"type": "text", "text": "这段音频说了什么？用一个词回答。"},
            {"type": "input_audio", "input_audio": {
                "data": f"data:audio/wav;base64,{audio_b64}"}},
        ], None
    return None, "不支持的探测类型"


def _classify_probe_error(exc: Exception, dim_label: str) -> tuple[bool | None, int, str]:
    status = getattr(exc, "status_code", None) or 0
    message = redact(str(exc))[:200]
    if status in (400, 422):
        unsupported_hints = (
            "not support", "unsupported", "does not support", "don't support",
            "invalid image", "invalid video", "invalid audio",
            "image not", "video not", "audio not",
            "media type", "content type", "unrecognized", "unknown field",
            "image_url", "video_url", "input_audio", "image_urls",
        )
        if any(hint in message.lower() for hint in unsupported_hints):
            return False, status, f"模型拒绝了{dim_label}输入，应为纯文本模型：{message}"
        return None, status, f"未能判定（{status}）：{message}"
    if status in (401, 403):
        return None, status, f"鉴权失败（{status}），先确认 Key/连通性再测"
    if status == 404:
        return None, status, f"模型名或地址不对（{status}）：{message}"
    return None, status, f"未能判定：{message}"


async def _close_probe_client(client) -> None:
    close = getattr(client, "close", None)
    if close is None:
        return
    try:
        result = close()
        if inspect.isawaitable(result):
            await result
    except Exception as exc:
        diag_log("multimodal_probe.close_client", exc)


async def probe_multimodal_capability(
    target: MultimodalProbeTarget,
    *,
    dim: str = "image",
) -> tuple[bool | None, int, str]:
    """探测指定模型的媒体输入能力；只测试，不更改任何凭据或模型配置。"""
    dim_label = {"image": "图片", "video": "视频", "audio": "音频"}.get(dim, dim)
    try:
        adapter = providers.adapter_for(target)
        is_anthropic = adapter.protocol_format(target) == "anthropic"
        read_timeout = 90.0 if dim == "video" else 25.0
        timeout = httpx.Timeout(connect=10.0, read=read_timeout, write=10.0, pool=5.0)
    except Exception as exc:
        diag_log("multimodal_probe.setup", exc)
        return None, 0, f"检测初始化失败（{type(exc).__name__}），请检查 Provider、协议和 Base URL"

    known_result = _known_capability_result(adapter, target.model, is_anthropic, dim, dim_label)
    if known_result is not None:
        return known_result

    client = None
    try:
        if is_anthropic:
            content = _anthropic_content(dim)
            if content is None:
                return False, 200, "Anthropic 路不支持该媒体探测类型"
            client = providers.build_anthropic_client(target, timeout)
            await client.messages.create(
                model=target.model, max_tokens=16, messages=[{"role": "user", "content": content}],
            )
        else:
            content, sample_error = await _openai_content(dim)
            if sample_error is not None:
                return None, 200, sample_error
            if content is None:
                return None, 0, "不支持的探测类型"
            client = providers.build_openai_client(target, timeout)
            await client.chat.completions.create(
                model=target.model, max_tokens=16, messages=[{"role": "user", "content": content}],
            )
        return True, 200, f"模型接受了{dim_label}输入"
    except Exception as exc:
        return _classify_probe_error(exc, dim_label)
    finally:
        await _close_probe_client(client)
