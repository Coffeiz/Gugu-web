"""文件库与历史附件共用的图片、音频和视频读取能力。

网络图片的下载与 URL 安全校验仍由 files/transfer.py 负责；本模块只处理已有存储对象，
并为网络图片提供共用的图片内容块构造策略。
"""
from __future__ import annotations

import base64
from contextvars import ContextVar

from agent.media import audio, gates, images, video
from agent.media.constants import IMAGE_READ_MAX, MEDIA_MIME, VISION_MIME
from agent.media.errors import MediaPreflightError
from agent.voice_config import normalize_voice_recognition_profile, voice_recognition_profile
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


class AudioTranscriptionError(Exception):
    """语音识别调用失败；不向工具结果暴露上游异常细节。"""


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


async def _transcribe_audio(raw: bytes, mime: str, ext: str = "", *, duration=None,
                            db=None, user_id=None) -> str | None:
    from agent.voice import transcribe
    audio_media = [{"type": "audio", "mime": mime, "ext": ext,
                    "b64": base64.b64encode(raw).decode(), "duration": duration}]
    try:
        return await transcribe(audio_media, get_settings(), db=db, user_id=user_id, raise_errors=True)
    except MediaPreflightError:
        raise
    except Exception as exc:
        raise AudioTranscriptionError("语音识别服务调用失败") from exc


def _audio_transcription_error(text: str | None) -> str | None:
    if text is None:
        return "未配置可用的语音识别模型"
    if not text.strip():
        return "未识别到语音内容，请确认文件包含清晰语音且格式受支持"
    return None


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
    return ext.lower().lstrip(".") in audio.native_audio_extensions(ai)


async def _audio_route(ai, ext: str, user_id, *, db=None):
    """解析本轮音频路由、字节上限与不可用原因。"""
    if _native_audio_enabled(ai, ext):
        return None, gates.media_limits_for(ai).audio_max_bytes, None
    profile_value = (
        await voice_recognition_profile(user_id, db=db) if db is not None
        else await voice_recognition_profile(user_id)
    )
    profile = normalize_voice_recognition_profile(profile_value)
    if profile.configured:
        return profile, profile.max_file_bytes, None
    if not profile.resolved:
        reason = "无法确认当前语音识别配置，未尝试发送音频；请检查配置后重试"
    else:
        reason = "未配置可用的语音识别模型，当前主模型也无法原生读取此音频格式"
    return profile, None, reason


async def _preflight_audio_duration(raw: bytes, ext: str, profile):
    """对 Provider 已声明时长上限的音频提前探测并校验。"""
    return await audio.preflight_duration(
        raw, ext, getattr(profile, "max_duration_s", None),
        getattr(profile, "provider_label", None) or "语音识别服务",
    )


async def read_audio(file, *, max_source_bytes: int | None = None, db=None, user_id=None) -> dict:
    try:
        ai = _active_model_cfg()
        source_user_id = user_id or getattr(file, "user_id", None)
        voice_profile, provider_limit, route_error = await _audio_route(
            ai, file.ext, source_user_id, db=db,
        )
        if route_error:
            return {"error": route_error}
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
        duration = await _preflight_audio_duration(data, file.ext.lower(), voice_profile)
        text = await _transcribe_audio(
            data, f"audio/{file.ext.lower()}", file.ext.lower(), duration=duration,
            db=db, user_id=source_user_id,
        )
    except MediaPreflightError as error:
        return {"error": str(error)}
    except AudioTranscriptionError as error:
        diag_log("agent.tools.media_reader.read_audio.transcription", error.__cause__ or error)
        return {"error": "语音识别服务调用失败，请检查配置或稍后重试"}
    except Exception as error:
        diag_log(f"agent.tools.media_reader.read_audio.file_id={file.id}", error)
        return {"error": "音频读取失败"}
    error = _audio_transcription_error(text)
    if error:
        return {"error": error}
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
        from agent.media.budget import VIDEO_MEMORY_BUDGET
        from agent.media.video_source import prepare_video_path
        local = (get_storage().local_path(file.storage_key)
                 if limits.prefer_file_upload and info.size > limits.base64_max else None)
        if local is not None:
            media_item = await prepare_video_path(local, mime, f"{file.display_name}.{file.ext}", ai,
                storage_key=file.storage_key, user_id=file.user_id, probe=probe,
                max_source_bytes=max_source_bytes)
            source_size = info.size
        else:
            async with VIDEO_MEMORY_BUDGET.reserve(info.size * 4):
                raw = await get_storage().get(file.storage_key)
                media_item = await video.prepare_video_media(
                    raw, mime, f"{file.display_name}.{file.ext}", ai,
                    storage_key=file.storage_key, user_id=file.user_id,
                    duration=(probe or {}).get("duration"), probe=probe,
                )
                source_size = len(raw)
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
        "_media_block": block, "_source_size_bytes": source_size,
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


async def read_local_media(path, *, db=None, user_id=None,
                           max_source_bytes: int | None = None) -> dict:
    """读取 system 范围的本地媒体文件，复用与文件库相同的模型能力和 Provider 策略。"""
    import asyncio
    from pathlib import Path

    path = Path(path)
    ext = path.suffix.lower().lstrip(".")
    try:
        metadata = await asyncio.to_thread(path.stat)
    except OSError:
        return {"error": "媒体文件不存在或不可读取"}
    if not path.is_file():
        return {"error": "只支持读取普通媒体文件"}
    if max_source_bytes is not None and metadata.st_size > max_source_bytes:
        return {"error": "本批次剩余容量不足，未读取该媒体"}

    if ext in IMAGE_EXTS:
        error = image_capability_error(ext, metadata.st_size)
        if error:
            return {"error": error}
        try:
            raw = await asyncio.to_thread(path.read_bytes)
        except OSError:
            return {"error": "图片文件不存在或不可读取"}
        result = build_image_block(raw, ext)
        if result.get("error"):
            return result
        return {
            "_image_block": result["block"],
            "_source_size_bytes": len(raw),
            "note": f"已打开系统环境图片《{path.name}》，见随附图像。",
        }

    if ext in AUDIO_EXTS:
        ai = _active_model_cfg()
        voice_profile, provider_limit, route_error = await _audio_route(
            ai, ext, user_id, db=db,
        )
        if route_error:
            return {"error": route_error}
        if metadata.st_size > provider_limit:
            return {"error": f"音频超过当前读取上限（{provider_limit // 1_000_000}MB）"}
        try:
            raw = await asyncio.to_thread(path.read_bytes)
        except OSError:
            return {"error": "音频文件不存在或不可读取"}
        if len(raw) > provider_limit or (max_source_bytes is not None and len(raw) > max_source_bytes):
            return {"error": "音频文件读取后超过大小限制"}
        try:
            if _native_audio_enabled(ai, ext):
                mime = MEDIA_MIME.get(ext) or f"audio/{ext}"
                block = video.media_item_to_content_block({
                    "type": "audio", "mime": mime,
                    "b64": base64.b64encode(raw).decode(),
                }, use_anthropic=False)
                if not block:
                    return {"error": "当前模型无法接收此音频格式"}
                return {
                    "_media_block": block,
                    "_source_size_bytes": len(raw),
                    "note": f"已读取音频《{path.name}》，请直接结合音频内容回答。",
                }
            duration = await _preflight_audio_duration(raw, ext, voice_profile)
            text = await _transcribe_audio(
                raw, MEDIA_MIME.get(ext) or f"audio/{ext}", ext,
                duration=duration, db=db, user_id=user_id,
            )
        except MediaPreflightError as error:
            return {"error": str(error)}
        except AudioTranscriptionError as error:
            diag_log("agent.tools.media_reader.read_local_audio.transcription", error.__cause__ or error)
            return {"error": "语音识别服务调用失败，请检查配置或稍后重试"}
        except Exception as error:
            diag_log("agent.tools.media_reader.read_local_audio", error)
            return {"error": "音频读取失败"}
        error = _audio_transcription_error(text)
        if error:
            return {"error": error}
        return {"name": path.name, "content": text, "_source_size_bytes": len(raw)}

    if ext in VIDEO_EXTS:
        ai = _active_model_cfg()
        transport = gates.video_transport_for(ai)
        if not getattr(ai, "video", False) or transport == "none":
            return {"error": "当前模型或 API 协议未开启原生视频理解，请切换到支持视频输入的模型"}
        mime = MEDIA_MIME.get(ext) or f"video/{ext}"
        try:
            video.validate_video_source(metadata.st_size, mime, ai)
            probe = None
            limits = gates.media_limits_for(ai)
            if limits.transcode_video or limits.max_duration_s is not None:
                probe = await video.probe_video_path(path)
            if probe is not None:
                video.check_video_duration(probe.get("duration"), ai)
            from agent.media.video_source import prepare_video_path
            media_item = await prepare_video_path(path, mime, path.name, ai, user_id=user_id,
                                                 probe=probe, max_source_bytes=max_source_bytes)
        except ValueError as error:
            return {"error": str(error)}
        except Exception as error:
            diag_log("agent.tools.media_reader.read_local_video", error)
            return {"error": "视频读取失败"}
        block = (video.video_media_to_anthropic_block(media_item)
                 if transport == "anthropic"
                 else video.video_media_to_openai_block(media_item))
        if not block:
            return {"error": "视频读取失败"}
        return {
            "_media_block": block, "_source_size_bytes": metadata.st_size,
            "note": f"已读取视频《{path.name}》。",
        }

    return {"error": f"不支持读取该媒体类型（{ext or '无扩展名'}）"}
