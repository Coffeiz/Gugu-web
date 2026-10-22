"""文件库与历史附件共用的图片、音频和视频读取能力。

网络图片的下载与 URL 安全校验仍由 files/transfer.py 负责；本模块只处理已有存储对象，
并为网络图片提供共用的图片内容块构造策略。
"""
from __future__ import annotations

import base64
from contextvars import ContextVar

from agent.media import gates, images, video
from agent.media.constants import IMAGE_READ_MAX, MEDIA_MIME, VISION_MIME
from agent.voice_config import voice_recognition_profile
from app.core import chat_attach
from app.core.chat_attach.file_types import IMAGE_EXTS as ATTACHMENT_IMAGE_EXTS
from app.core.config import get_settings
from app.core.redaction import diag_log
from app.services import storage as storage_service

VIDEO_EXTS = frozenset({"mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v"})
AUDIO_EXTS = frozenset({"mp3", "wav", "flac", "m4a", "ogg", "aac", "amr", "opus", "wma"})
IMAGE_EXTS = frozenset(ATTACHMENT_IMAGE_EXTS)
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
    if not images.image_ready():
        return "当前模型/通道无法识别图像内容"
    normalized_ext = str(ext or "").lower().lstrip(".")
    if ext is not None and normalized_ext not in ATTACHMENT_IMAGE_EXTS:
        return f"图片格式 {normalized_ext or '未知'} 暂不支持识别"
    if ext is not None:
        provider_image_limits = gates.media_limits_for(_active_model_cfg())
        mime = VISION_MIME.get(normalized_ext)
        if (provider_image_limits.image_extensions
                and normalized_ext not in provider_image_limits.image_extensions):
            return "当前 Provider 不支持这种图片格式"
        if provider_image_limits.image_mimes and mime not in provider_image_limits.image_mimes:
            return "当前 Provider 不支持这种图片格式"
    if size is not None:
        provider_limit = gates.media_limits_for(_active_model_cfg()).image_max_bytes
        if provider_limit is not None and size > provider_limit:
            return f"图片超过当前 Provider 的单图上限（{provider_limit // 1_000_000}MB）"
    if size is not None and size > IMAGE_READ_MAX:
        return "图片过大，超出可看上限"
    return None


def build_image_block(raw: bytes, ext: str) -> dict:
    """将图片按统一白名单与视觉预处理策略转换成模型内容块。"""
    error = image_capability_error(ext, len(raw))
    if error:
        return {"error": error}
    block = images.image_block(raw, ext, model_cfg=_active_model_cfg())
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


async def _transcribe_audio(raw: bytes, mime: str, ext: str = "", *, db=None, user_id=None) -> str:
    from agent.voice import transcribe
    audio_media = [{"type": "audio", "mime": mime, "ext": ext, "b64": base64.b64encode(raw).decode()}]
    return (await transcribe(audio_media, get_settings(), db=db, user_id=user_id)) or ""


async def _media_size_error(file, max_source_bytes: int | None = None,
                            provider_limit_bytes: int = MEDIA_READ_MAX_BYTES) -> dict | None:
    """以物理对象大小为准，避免历史 size_bytes=0 绕过内存门禁。"""
    info = await get_storage().stat(file.storage_key)
    if info is None:
        return {"error": "媒体文件不存在，无法读取"}
    if max_source_bytes is not None and info.size > max_source_bytes:
        return {"error": "本批次剩余容量不足，未读取该媒体"}
    if info.size > provider_limit_bytes:
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
    if not gates.audio_enabled(ai):
        return False
    from agent import providers
    adapter = providers.adapter_for(ai)
    return ext.lower() in adapter.audio_native_exts()


async def read_audio(file, *, max_source_bytes: int | None = None, db=None, user_id=None) -> dict:
    try:
        ai = _active_model_cfg()
        if _native_audio_enabled(ai, file.ext):
            provider_limit = gates.media_limits_for(ai).audio_max_bytes
        else:
            voice_ok, voice_limit = await voice_recognition_profile(
                user_id or getattr(file, "user_id", None),
            )
            provider_limit = voice_limit if voice_ok else MEDIA_READ_MAX_BYTES
        error = await _media_size_error(file, max_source_bytes, provider_limit)
        if error:
            return error
        data = await get_storage().get(file.storage_key)
        if _native_audio_enabled(ai, file.ext):
            mime = MEDIA_MIME.get(file.ext.lower()) or f"audio/{file.ext.lower()}"
            media_item = {
                "type": "audio", "mime": mime,
                "b64": base64.b64encode(data).decode(),
            }
            block = video.media_item_to_content_block(media_item, use_anthropic=False)
            if not block:
                return {"error": "当前模型无法接收此音频格式"}
            return {
                "_media_block": block,
                "_source_size_bytes": len(data),
                "note": f"已读取音频《{file.display_name}.{file.ext}》，请直接结合音频内容回答。",
            }
        text = await _transcribe_audio(
            data, f"audio/{file.ext.lower()}", file.ext.lower(),
            db=db, user_id=user_id or getattr(file, "user_id", None),
        )
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
    transport = gates.video_transport_for(ai)
    if not getattr(ai, "video", False) or transport == "none":
        return {"error": "当前模型或 API 协议未开启原生视频理解，请切换到支持视频输入的模型"}

    ext = file.ext.lower()
    try:
        info = await get_storage().stat(file.storage_key)
        if info is None:
            return {"error": "媒体文件不存在，无法读取"}
        if max_source_bytes is not None and info.size > max_source_bytes:
            return {"error": "本批次剩余容量不足，未读取该视频"}
        mime = MEDIA_MIME.get(ext) or f"video/{ext}"
        # 依据同一份 Provider 规格在读入文件前检查大小和媒体类型。
        video.validate_video_source(info.size, mime, ai)
        # 时长闸门前置到「读字节之前」：按存储路径探测（ffprobe 按需 seek，IO 量是
        # KB 级），超限直接拒——不用为了拒绝一个 235MB 的视频先把整份读进内存、
        # 再落一份临时文件才换来一句"太长了"。探测结果直接透传给
        # prepare_video_media，避免它再探一次。
        limits = gates.media_limits_for(ai)
        probe = None
        if limits.transcode_video or limits.max_duration_s is not None:
            probe = await video.probe_video_at(file.storage_key)
        if probe is not None:
            video.check_video_duration(probe.get("duration"), ai)
        raw = await get_storage().get(file.storage_key)
        media_item = await video.prepare_video_media(
            raw, mime, f"{file.display_name}.{file.ext}", ai,
            storage_key=file.storage_key, user_id=file.user_id,
            duration=(probe or {}).get("duration"), probe=probe,
        )
    except ValueError as error:
        return {"error": str(error)}
    except Exception as error:
        diag_log(f"agent.tools.media_reader.read_video.file_id={file.id}", error)
        return {"error": "视频读取失败"}

    block = (video.video_media_to_anthropic_block(media_item)
             if transport == "anthropic"
             else video.video_media_to_openai_block(media_item))
    if not block:
        return {"error": "视频读取失败"}
    return {
        "_media_block": block, "_source_size_bytes": len(raw),
        "note": f"已读取视频《{file.display_name}.{file.ext}》。",
    }


async def read_media(file, *, max_source_bytes: int | None = None, db=None, user_id=None) -> dict:
    ext = file.ext.lower()
    if ext in AUDIO_EXTS:
        return await read_audio(file, max_source_bytes=max_source_bytes, db=db, user_id=user_id)
    if ext in VIDEO_EXTS:
        return await read_video(file, max_source_bytes=max_source_bytes)
    if ext in IMAGE_EXTS:
        return await read_stored_image(file.storage_key, ext, max_source_bytes=max_source_bytes)
    return {"error": "不支持的媒体格式"}
