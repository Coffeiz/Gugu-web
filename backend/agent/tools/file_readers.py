"""read_file 的媒体读取处理器。

文本和 Office 文档仍由 files.py 负责；这里集中处理需要外部媒体工具的音频/视频，
避免把 ffmpeg、ASR 和视觉模型分支继续堆进 read_file。
"""
from __future__ import annotations

import asyncio
import base64
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from app.core.config import get_settings
from app.core import chat_attach
from app.core.redaction import diag_log
from app.services.storage import get_storage

VIDEO_EXTS = frozenset({"mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v"})
AUDIO_EXTS = frozenset({"mp3", "wav", "flac", "m4a", "ogg", "aac", "amr", "opus", "wma"})
MEDIA_READ_MAX_BYTES = 36 * 1024 * 1024   # 仅 read_audio 用：转写要整段音频进内存，视频走 _materialize_video 不受此限
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


async def _run_ffmpeg(source: Path, args: list[str], max_output_bytes: int) -> bytes | None:
    """对已经落在磁盘上的 source 文件跑 ffmpeg，只把 <=max_output_bytes 的输出读进内存。

    source 由调用方（_materialize_video）负责物化和清理——这里不再自己把整段视频
    写一份临时文件，避免「读视频要先整段进内存、再整段落一次临时文件」的双重开销。
    """
    ffmpeg = _ffmpeg()
    if not ffmpeg:
        return None
    try:
        async with _FFMPEG_SEMAPHORE:
            proc = await asyncio.create_subprocess_exec(
                ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-i", str(source), *args,
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


async def _extract_audio(source: Path) -> bytes | None:
    return await _run_ffmpeg(
        source,
        ["-vn", "-t", str(MEDIA_AUDIO_MAX_SECONDS), "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"],
        MEDIA_AUDIO_MAX_OUTPUT_BYTES,
    )


async def _extract_frame(source: Path) -> bytes | None:
    # 取中前段画面，避免只取首帧时遇到黑场或片头；短视频由 ffmpeg 自动退回可用帧。
    return await _run_ffmpeg(
        source,
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


@asynccontextmanager
async def _materialize_video(file):
    """把视频物化成本地磁盘文件，供 ffmpeg 直接按需读取（不整段读进 Python 内存）。

    read_video 只需要第 1 秒附近一帧画面 + 前 300 秒音频，压根不需要把整段视频过一遍
    内存——旧实现（PRD-LLM-3 追加项）反而是「超限就整段下载 + 整段压成新视频」，OSS 后端
    因为 stat() 默认实现是 exists+get，等于每次读取都要把大文件从 OSS 拉两遍。
    现在本地存储直接用真实路径（零拷贝）；远程后端流式下载到临时文件，只多落一份磁盘
    文件（磁盘不像内存那么金贵），用完即删。视频本身大小不再是这里的门禁——ffmpeg 处理
    的是磁盘文件，真正进 Python 内存的只有下面 <=8MB 的画面帧和 <=16MB 的音频。
    """
    storage = get_storage()
    local = storage.local_path(file.storage_key)
    if local is not None:
        yield local
        return
    fd, tmp_path = tempfile.mkstemp(suffix=f".{file.ext.lower()}", prefix="gugu_video_")
    os.close(fd)
    tmp = Path(tmp_path)
    try:
        await storage.download_to_file(file.storage_key, tmp)
        yield tmp
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


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
        info = await get_storage().stat(file.storage_key)
        if info is None:
            return {"error": "媒体文件不存在，无法读取"}
        async with _materialize_video(file) as source:
            frame = await _extract_frame(source)
            audio = await _extract_audio(source)
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
