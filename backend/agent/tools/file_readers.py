"""read_file 的媒体读取处理器。

文本和 Office 文档仍由 files.py 负责；这里集中处理需要外部媒体工具的音频/视频，
避免把 ASR 和视频理解分支继续堆进 read_file。
"""
from __future__ import annotations

import base64

from app.core.config import get_settings
from app.core import chat_attach
from app.core.redaction import diag_log
from app.services.storage import get_storage

VIDEO_EXTS = frozenset({"mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v"})
AUDIO_EXTS = frozenset({"mp3", "wav", "flac", "m4a", "ogg", "aac", "amr", "opus", "wma"})
MEDIA_READ_MAX_BYTES = 36 * 1024 * 1024


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
    """把文件库里的视频作为真正的视频内容交给模型看，复用 chat_attach 的聊天附件
    视频理解能力（压缩阈值/base64 vs mm_file/大小上限全部在
    `chat_attach.prepare_video_media` 里，这里不重新实现一套）。

    视频 tool_result 里的 content block 只有 Anthropic 通道（MiniMax M3）能承载——
    OpenAI 路的 tool 结果只能是纯文本（见 agent/tools/base.py dispatch 的
    `_video_media` 处理），所以这里先判 provider 能力，不满足直接返回明确的
    "当前模型不支持"错误，而不是退化成代表帧/转写这类近似方案。

    能力判断必须用**这轮真正在跑的模型**（`agent.llm.modelctx.get_model_cfg()`），
    不能重新读静态的 `get_settings().ai`——pool/router 场景下两者可能不是同一个
    模型，用错了会出现"顶层配的是 MiniMax、这轮实际跑 mimo，却按 MiniMax 生成
    Anthropic video block"或反过来"误判不支持"。`modelctx` 读不到（没有走
    `LLMRunner._run_loop`，理论上不会发生，兜底而已）才退回 `settings.ai`。
    """
    from agent.llm import modelctx
    try:
        ai = modelctx.get_model_cfg() or get_settings().ai
    except Exception as error:
        diag_log(f"agent.file_readers.read_video.file_id={file.id}", error)
        return {"error": "视频读取失败"}
    if chat_attach.video_transport_for(ai) != "anthropic":
        return {"error": "当前模型不支持通过文件库直接看视频（视频理解目前仅 MiniMax M3 支持）"}

    ext = file.ext.lower()
    try:
        info = await get_storage().stat(file.storage_key)
        if info is None:
            return {"error": "媒体文件不存在，无法读取"}
        # 源文件超过处理上限时用 stat() 已经拿到的物理大小直接拒绝，不要先把整个
        # 文件读进内存再交给 prepare_video_media 判断——stat() 通常只是一次元信息
        # 查询（本地 os.stat / OSS head_object 级别），比整段 get() 便宜得多，没必要
        # 为了一个注定要拒绝的 500MB+ 视频先申请 500MB 内存（code review 指出）。
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
        diag_log(f"agent.file_readers.read_video.file_id={file.id}", error)
        return {"error": "视频读取失败"}

    block = chat_attach.video_media_to_anthropic_block(media_item)
    if not block:
        return {"error": "视频读取失败"}
    return {"_video_media": block, "note": f"已读取视频《{file.display_name}.{file.ext}》。"}


async def read_media(file) -> dict:
    ext = file.ext.lower()
    if ext in AUDIO_EXTS:
        return await read_audio(file)
    if ext in VIDEO_EXTS:
        return await read_video(file)
    return {"error": "不支持的媒体格式"}
