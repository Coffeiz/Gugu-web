"""read_file 的媒体读取处理器。

文本和 Office 文档仍由 files.py 负责；这里集中处理需要外部媒体工具的音频/视频，
避免把 ffmpeg、ASR 和视觉模型分支继续堆进 read_file。
"""
from __future__ import annotations

import asyncio
import base64
import os
import tempfile

from app.core.config import get_settings
from app.core import chat_attach
from app.services.storage import get_storage

VIDEO_EXTS = frozenset({"mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v"})
AUDIO_EXTS = frozenset({"mp3", "wav", "flac", "m4a", "ogg", "aac", "amr", "opus", "wma"})
MEDIA_READ_MAX_BYTES = 128 * 1024 * 1024


def _ffmpeg() -> str | None:
    from app.core.media_transcode import _ffmpeg_bin
    return _ffmpeg_bin()


async def _run_ffmpeg(data: bytes, ext: str, args: list[str]) -> bytes | None:
    ffmpeg = _ffmpeg()
    if not ffmpeg:
        return None
    fd, source = tempfile.mkstemp(suffix=f".{ext}", prefix="gugu_media_")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        proc = await asyncio.create_subprocess_exec(
            ffmpeg, "-nostdin", "-y", "-i", source, *args,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        output, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
        return output if proc.returncode == 0 and output else None
    except (OSError, asyncio.TimeoutError):
        return None
    finally:
        try:
            os.unlink(source)
        except OSError:
            pass


async def _extract_audio(data: bytes, ext: str) -> bytes | None:
    return await _run_ffmpeg(
        data, ext,
        ["-vn", "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"],
    )


async def _extract_frame(data: bytes, ext: str) -> bytes | None:
    # 取中前段画面，避免只取首帧时遇到黑场或片头；短视频由 ffmpeg 自动退回可用帧。
    return await _run_ffmpeg(
        data, ext,
        ["-ss", "00:00:01", "-frames:v", "1", "-f", "image2", "pipe:1"],
    )


async def _transcribe_audio(raw: bytes, mime: str) -> str:
    from agent.voice import transcribe
    media = [{"type": "audio", "mime": mime, "b64": base64.b64encode(raw).decode()}]
    return (await transcribe(media, get_settings())) or ""


async def read_audio(file) -> dict | str:
    if (file.size_bytes or 0) > MEDIA_READ_MAX_BYTES:
        return f"{{\"error\":\"音频过大（{file.size}），超出读取上限\"}}"
    try:
        data = await get_storage().get(file.storage_key)
        text = await _transcribe_audio(data, f"audio/{file.ext.lower()}")
    except Exception:
        return '{"error":"音频读取失败"}'
    if not text:
        return '{"error":"音频无法转写，可能未配置语音模型或格式不受支持"}'
    return {"file_id": file.id, "name": f"{file.display_name}.{file.ext}", "content": text}


async def read_video(file) -> dict | str:
    if (file.size_bytes or 0) > MEDIA_READ_MAX_BYTES:
        return f"{{\"error\":\"视频过大（{file.size}），超出读取上限\"}}"
    try:
        data = await get_storage().get(file.storage_key)
        frame = await _extract_frame(data, file.ext.lower())
        audio = await _extract_audio(data, file.ext.lower())
        transcript = await _transcribe_audio(audio, "audio/wav") if audio else ""
    except Exception:
        return '{"error":"视频读取失败"}'

    if frame and chat_attach.vision_ready():
        block = chat_attach.vision_block(frame, "png")
        if block:
            note = f"已读取视频《{file.display_name}.{file.ext}》的代表画面。"
            if transcript:
                note += f"音频转写：{transcript}"
            return {"_vision_image": block, "note": note}
    if transcript:
        return {"file_id": file.id, "name": f"{file.display_name}.{file.ext}",
                "content": f"视频音频转写：\n{transcript}"}
    return '{"error":"视频无法读取：当前未配置可用的视觉模型或语音模型"}'


async def read_media(file) -> dict | str:
    ext = file.ext.lower()
    if ext in AUDIO_EXTS:
        return await read_audio(file)
    if ext in VIDEO_EXTS:
        return await read_video(file)
    return '{"error":"不支持的媒体格式"}'
