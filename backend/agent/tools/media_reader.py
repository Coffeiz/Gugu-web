"""文件库与历史附件共用的图片、音频和视频读取能力。

网络图片的下载与 URL 安全校验仍由 files/transfer.py 负责；本模块只处理已有存储对象，
并为网络图片提供共用的图片内容块构造策略。
"""
from __future__ import annotations

import base64
from contextvars import ContextVar

from app.core import chat_attach
from app.core.config import get_settings
from app.core.redaction import diag_log
from app.services import storage as storage_service

VIDEO_EXTS = frozenset({"mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v"})
AUDIO_EXTS = frozenset({"mp3", "wav", "flac", "m4a", "ogg", "aac", "amr", "opus", "wma"})
IMAGE_EXTS = frozenset(chat_attach.VISION_EXTS)
MEDIA_EXTS = IMAGE_EXTS | AUDIO_EXTS | VIDEO_EXTS
MEDIA_READ_MAX_BYTES = 36 * 1024 * 1024
MEDIA_BATCH_MAX_ITEMS = 20
MEDIA_BATCH_MAX_BYTES = 64 * 1024 * 1024
MAX_REMOTE_IMAGE_READ_CALLS = 3
_remote_image_read_calls: ContextVar[int] = ContextVar("remote_image_read_calls", default=0)


def get_storage():
    """延迟读取 storage backend，支持运行时后端替换与测试隔离。"""
    return storage_service.get_storage()


def reset_remote_image_read_budget() -> None:
    """开始一轮工具循环时重置网络图片读取额度。"""
    _remote_image_read_calls.set(0)


def reserve_remote_image_read() -> bool:
    """每轮最多允许三次含网络图片的 read_file 调用。"""
    count = _remote_image_read_calls.get()
    if count >= MAX_REMOTE_IMAGE_READ_CALLS:
        return False
    _remote_image_read_calls.set(count + 1)
    return True


def image_capability_error(ext: str | None = None, size: int | None = None) -> str | None:
    """统一检查视觉能力、格式与图片读取体积上限。"""
    if not chat_attach.vision_ready():
        return "当前模型/通道无法识别图像内容"
    normalized_ext = str(ext or "").lower().lstrip(".")
    if ext is not None and normalized_ext not in chat_attach.VISION_EXTS:
        return f"图片格式 {normalized_ext or '未知'} 暂不支持识别"
    if size is not None and size > chat_attach.VISION_READ_MAX:
        return "图片过大，超出可看上限"
    return None


def build_image_block(raw: bytes, ext: str) -> dict:
    """将图片按统一白名单与视觉预处理策略转换成模型内容块。"""
    error = image_capability_error(ext, len(raw))
    if error:
        return {"error": error}
    block = chat_attach.vision_block(raw, ext)
    return ({"block": block, "_source_size_bytes": len(raw)}
            if block else {"error": "图片无法解析"})


async def read_stored_image(storage_key: str, ext: str, *, max_source_bytes: int | None = None) -> dict:
    """安全读取文件库或聊天暂存中的图片，先查物理大小，再读字节。"""
    error = image_capability_error(ext)
    if error:
        return {"error": error}
    try:
        storage = get_storage()
        info = await storage.stat(storage_key)
        if info is None:
            return {"error": "图片文件不存在"}
        if max_source_bytes is not None and info.size > max_source_bytes:
            return {"error": "本批次剩余容量不足，未读取该图片"}
        error = image_capability_error(ext, info.size)
        if error:
            return {"error": error}
        raw = await storage.get(storage_key)
    except Exception as exc:
        diag_log("agent.tools.media_reader.read_stored_image", exc)
        return {"error": "图片读取失败"}

    # stat 和 get 之间对象可能变化；按实际字节再做一次硬限制。
    return build_image_block(raw, ext)


async def _transcribe_audio(raw: bytes, mime: str) -> str:
    from agent.voice import transcribe
    media = [{"type": "audio", "mime": mime, "b64": base64.b64encode(raw).decode()}]
    return (await transcribe(media, get_settings())) or ""


async def _media_size_error(file, max_source_bytes: int | None = None) -> dict | None:
    """以物理对象大小为准，避免历史 size_bytes=0 绕过内存门禁。"""
    info = await get_storage().stat(file.storage_key)
    if info is None:
        return {"error": "媒体文件不存在，无法读取"}
    if max_source_bytes is not None and info.size > max_source_bytes:
        return {"error": "本批次剩余容量不足，未读取该媒体"}
    if info.size > MEDIA_READ_MAX_BYTES:
        return {"error": f"媒体过大（{info.size} bytes），超出读取上限"}
    return None


def _active_model_cfg():
    """优先读取本轮真正执行的模型，兼容不在 LLM loop 内调用的测试/工具入口。"""
    from agent.llm import modelctx
    try:
        return modelctx.get_model_cfg() or get_settings().ai
    except Exception:
        return get_settings().ai


def _native_audio_enabled(ai, ext: str) -> bool:
    """当前主模型及其实际协议支持该音频格式时，才把原音频交给主模型。"""
    if not chat_attach._audio_enabled(ai):
        return False
    from agent import providers
    adapter = providers.adapter_for(ai)
    return ext.lower() in adapter.audio_native_exts()


async def read_audio(file, *, max_source_bytes: int | None = None) -> dict:
    try:
        error = await _media_size_error(file, max_source_bytes)
        if error:
            return error
        data = await get_storage().get(file.storage_key)
        ai = _active_model_cfg()
        if _native_audio_enabled(ai, file.ext):
            mime = chat_attach._MEDIA_MIME.get(file.ext.lower()) or f"audio/{file.ext.lower()}"
            media_item = {
                "type": "audio", "mime": mime,
                "b64": base64.b64encode(data).decode(),
            }
            block = chat_attach.media_item_to_content_block(media_item, use_anthropic=False)
            if not block:
                return {"error": "当前模型无法接收此音频格式"}
            return {
                "_media_block": block,
                "_source_size_bytes": len(data),
                "note": f"已读取音频《{file.display_name}.{file.ext}》，请直接结合音频内容回答。",
            }
        text = await _transcribe_audio(data, f"audio/{file.ext.lower()}")
    except Exception as error:
        diag_log(f"agent.tools.media_reader.read_audio.file_id={file.id}", error)
        return {"error": "音频读取失败"}
    if not text:
        return {"error": "音频无法转写，可能未配置语音模型或格式不受支持"}
    return {
        "file_id": file.id, "name": f"{file.display_name}.{file.ext}",
        "content": text, "_source_size_bytes": len(data),
    }


async def read_video(file, *, max_source_bytes: int | None = None) -> dict:
    """按本轮主模型已启用的原生视频能力读取；压缩与 provider payload 共用附件逻辑。"""
    ai = _active_model_cfg()
    transport = chat_attach.video_transport_for(ai)
    if not getattr(ai, "vision_video", False) or transport == "none":
        return {"error": "当前模型或 API 协议未开启原生视频理解，请切换到支持视频输入的模型"}

    ext = file.ext.lower()
    try:
        info = await get_storage().stat(file.storage_key)
        if info is None:
            return {"error": "媒体文件不存在，无法读取"}
        if max_source_bytes is not None and info.size > max_source_bytes:
            return {"error": "本批次剩余容量不足，未读取该视频"}
        # 源文件超过处理上限时用 stat() 已经拿到的物理大小直接拒绝，不要先把整个
        # 文件读进内存再交给 prepare_video_media 判断。
        if info.size > chat_attach.VIDEO_SOURCE_MAX:
            return {"error": "这条视频太大（超过 500MB 处理上限），没法直接看"}
        raw = await get_storage().get(file.storage_key)
        mime = chat_attach._MEDIA_MIME.get(ext) or f"video/{ext}"
        media_item = await chat_attach.prepare_video_media(
            raw, mime, f"{file.display_name}.{file.ext}", ai,
            storage_key=file.storage_key, user_id=file.user_id,
        )
    except ValueError as error:
        return {"error": str(error)}
    except Exception as error:
        diag_log(f"agent.tools.media_reader.read_video.file_id={file.id}", error)
        return {"error": "视频读取失败"}

    block = (chat_attach.video_media_to_anthropic_block(media_item)
             if transport == "anthropic"
             else chat_attach.video_media_to_openai_block(media_item))
    if not block:
        return {"error": "视频读取失败"}
    return {
        "_media_block": block, "_source_size_bytes": len(raw),
        "note": f"已读取视频《{file.display_name}.{file.ext}》。",
    }


async def read_media(file, *, max_source_bytes: int | None = None) -> dict:
    ext = file.ext.lower()
    if ext in AUDIO_EXTS:
        return await read_audio(file, max_source_bytes=max_source_bytes)
    if ext in VIDEO_EXTS:
        return await read_video(file, max_source_bytes=max_source_bytes)
    if ext in IMAGE_EXTS:
        return await read_stored_image(file.storage_key, ext, max_source_bytes=max_source_bytes)
    return {"error": "不支持的媒体格式"}
