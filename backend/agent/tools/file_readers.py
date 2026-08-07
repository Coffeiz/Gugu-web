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
from app.core.redaction import diag_log
from app.services.storage import get_storage

VIDEO_EXTS = frozenset({"mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v"})
AUDIO_EXTS = frozenset({"mp3", "wav", "flac", "m4a", "ogg", "aac", "amr", "opus", "wma"})
MEDIA_READ_MAX_BYTES = 36 * 1024 * 1024
MEDIA_AUDIO_MAX_SECONDS = 300
MEDIA_AUDIO_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
MEDIA_FRAME_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MEDIA_FRAME_MAX_WIDTH = 1920
_FFMPEG_SEMAPHORE = asyncio.Semaphore(2)


def _ffmpeg() -> str | None:
    from app.core.media_transcode import _ffmpeg_bin
    return _ffmpeg_bin()


async def _read_limited(stream, max_bytes: int) -> bytes | None:
    """分块读取 ffmpeg 输出，超过上限时返回 None，让调用方终止子进程。"""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await stream.read(min(64 * 1024, max_bytes - total + 1))
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > max_bytes:
            return None
        chunks.append(chunk)


async def _run_ffmpeg(data: bytes, ext: str, args: list[str], max_output_bytes: int) -> bytes | None:
    ffmpeg = _ffmpeg()
    if not ffmpeg:
        return None
    fd, source = tempfile.mkstemp(suffix=f".{ext}", prefix="gugu_media_")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        async with _FFMPEG_SEMAPHORE:
            proc = await asyncio.create_subprocess_exec(
                ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-i", source, *args,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            stderr_task = asyncio.create_task(proc.stderr.read())
            try:
                output = await asyncio.wait_for(_read_limited(proc.stdout, max_output_bytes), timeout=60)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                raise
            finally:
                if proc.returncode is None:
                    proc.kill()
                await proc.wait()
                await stderr_task
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
        ["-vn", "-t", str(MEDIA_AUDIO_MAX_SECONDS), "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"],
        MEDIA_AUDIO_MAX_OUTPUT_BYTES,
    )


async def _extract_frame(data: bytes, ext: str) -> bytes | None:
    # 取中前段画面，避免只取首帧时遇到黑场或片头；短视频由 ffmpeg 自动退回可用帧。
    return await _run_ffmpeg(
        data, ext,
        ["-ss", "00:00:01", "-frames:v", "1", "-vf",
         f"scale={MEDIA_FRAME_MAX_WIDTH}:-2:force_original_aspect_ratio=decrease",
         "-f", "image2", "pipe:1"],
        MEDIA_FRAME_MAX_OUTPUT_BYTES,
    )


async def _transcribe_audio(raw: bytes, mime: str) -> str:
    from agent.voice import transcribe
    media = [{"type": "audio", "mime": mime, "b64": base64.b64encode(raw).decode()}]
    return (await transcribe(media, get_settings())) or ""


async def _media_size_error(file) -> dict | None:
    """以物理对象大小为准，避免历史 size_bytes=0 绕过内存门禁。"""
    info = await get_storage().stat(file.storage_key)
    if info is None:
        return {"error": "媒体文件不存在，无法读取"}
    if info.size > MEDIA_READ_MAX_BYTES:
        return {"error": f"媒体过大（{info.size} bytes），超出读取上限"}
    return None


async def _load_video_bytes(file) -> tuple[bytes | None, str, dict | None]:
    """取视频原始字节；超过读取上限时先尝试压缩一次，压完仍超限才报错。

    发送路径（chat_attach.py）早就有探测/压缩逻辑，但只用于「用户发视频给咕咕」，
    read_file 读文件库里已有的视频完全没走过——超过 MEDIA_READ_MAX_BYTES 一律直接
    拒绝，即使内容很简单也读不了（PRD-LLM-3 追加项）。这里读取只是截一帧画面+
    转写音频，用不上原始高清画质，压缩产物也不需要写回文件库，只在这次读取的
    生命周期内使用，成功与否都不影响存储里的原文件。
    """
    info = await get_storage().stat(file.storage_key)
    if info is None:
        return None, "", {"error": "媒体文件不存在，无法读取"}
    data = await get_storage().get(file.storage_key)
    if info.size <= MEDIA_READ_MAX_BYTES:
        return data, file.ext.lower(), None
    compressed = await chat_attach._compress_video(data)
    if not compressed or len(compressed) > MEDIA_READ_MAX_BYTES:
        return None, "", {"error": f"媒体过大（{info.size} bytes），压缩后仍超出读取上限"}
    return compressed, "mp4", None   # _compress_video 固定输出 mp4 容器，不沿用原始扩展名


async def read_audio(file) -> dict:
    try:
        error = await _media_size_error(file)
        if error:
            return error
        data = await get_storage().get(file.storage_key)
        text = await _transcribe_audio(data, f"audio/{file.ext.lower()}")
    except Exception as error:
        diag_log(f"agent.file_readers.read_audio.file_id={file.id}", error)
        return {"error": "音频读取失败"}
    if not text:
        return {"error": "音频无法转写，可能未配置语音模型或格式不受支持"}
    return {"file_id": file.id, "name": f"{file.display_name}.{file.ext}", "content": text}


async def read_video(file) -> dict:
    try:
        data, ext, error = await _load_video_bytes(file)
        if error:
            return error
        frame = await _extract_frame(data, ext)
        audio = await _extract_audio(data, ext)
        transcript = await _transcribe_audio(audio, "audio/wav") if audio else ""
    except Exception as error:
        diag_log(f"agent.file_readers.read_video.file_id={file.id}", error)
        return {"error": "视频读取失败"}

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
    return {"error": "视频无法读取：当前未配置可用的视觉模型或语音模型"}


async def read_media(file) -> dict:
    ext = file.ext.lower()
    if ext in AUDIO_EXTS:
        return await read_audio(file)
    if ext in VIDEO_EXTS:
        return await read_video(file)
    return {"error": "不支持的媒体格式"}
