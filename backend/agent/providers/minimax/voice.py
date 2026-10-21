"""MiniMax 独立语音识别 API。"""
from __future__ import annotations

import asyncio
import base64
import logging
import secrets
from urllib.parse import urlsplit

import httpx

from agent.providers.minimax import minimax_error_details
from app.core.credentials import normalize_ascii_api_key
from app.core.redaction import diag_log, redact

logger = logging.getLogger("agent.providers.minimax.voice")

_MAX_BYTES = 50 * 1024 * 1024
_MAX_SECONDS = 500.0
_EXT_MIME = {
    "wav": ("wav", "audio/wav"), "aiff": ("aiff", "audio/aiff"),
    "aif": ("aif", "audio/aiff"), "flac": ("flac", "audio/flac"),
    "m4a": ("m4a", "audio/mp4"), "mp3": ("mp3", "audio/mpeg"),
    "aac": ("aac", "audio/aac"), "opus": ("opus", "audio/opus"),
    "ogg": ("ogg", "audio/ogg"),
}


def supports_model(model: str) -> bool:
    return (model or "asr-1.0").strip() == "asr-1.0"


def is_minimax_error(error: BaseException) -> bool:
    return minimax_error_details(error) is not None


def log_transcription_error(context: str, error: BaseException, *, defer: bool = False) -> bool | None:
    """MiniMax 错误写入诊断日志；返回 None 表示不是 MiniMax 上游错误。"""
    details = minimax_error_details(error)
    if details is None:
        return None
    if defer:
        return True
    response = getattr(error, "response", None)
    status_code = getattr(error, "status_code", None) or getattr(response, "status_code", None)
    diagnostic_id = secrets.token_hex(8).upper()
    diag_log(
        f"{context} provider=minimax status={status_code or '-'} "
        f"error_code={details.code} error_type={details.error_type} "
        f"request_id={details.request_id or '-'} diagnostic_id={diagnostic_id}",
        error,
    )
    logger.warning(
        "MiniMax 语音转写失败 status=%s error_code=%s error_type=%s request_id=%s diagnostic_id=%s",
        status_code or "-", details.code, details.error_type,
        details.request_id or "-", diagnostic_id,
    )
    return True


def _endpoint(base_url: str) -> str:
    """只允许 MiniMax 官方 HTTPS ASR 地址，避免 API Key 被转发到任意主机。"""
    parsed = urlsplit((base_url or "").strip() or "https://api.minimax.cn")
    path = parsed.path.rstrip("/")
    if (parsed.scheme != "https" or parsed.hostname != "api.minimax.cn"
            or parsed.port not in (None, 443) or parsed.username or parsed.password
            or parsed.query or parsed.fragment
            or path not in {"", "/v1", "/v1/speech_to_text"}):
        raise ValueError("MiniMax ASR Base URL 只能使用官方 HTTPS 接口地址")
    return "https://api.minimax.cn/v1/speech_to_text"


def _audio_format(item: dict, mime: str) -> tuple[str, str] | None:
    """根据媒体元信息识别官方支持的容器；返回扩展名和 MIME。"""
    ext = str(item.get("ext") or "").lower().lstrip(".")
    if not ext:
        ext = {
            "audio/wav": "wav", "audio/x-wav": "wav", "audio/aiff": "aiff",
            "audio/x-aiff": "aiff", "audio/flac": "flac", "audio/x-flac": "flac",
            "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/mpeg": "mp3",
            "audio/mp3": "mp3", "audio/aac": "aac", "audio/opus": "opus",
            "audio/ogg": "ogg", "application/ogg": "ogg",
        }.get(mime, "")
    return _EXT_MIME.get(ext)


async def transcribe(media: list, vm, *, to_wav, raise_errors: bool = False) -> str:
    """调用 MiniMax 独立 multipart ASR API 转写音频。"""
    if not supports_model(getattr(vm, "model", "")):
        raise ValueError("MiniMax ASR 当前只支持 asr-1.0")
    endpoint = _endpoint(getattr(vm, "base_url", ""))
    api_key = normalize_ascii_api_key(vm.api_key, label="语音模型 API Key")
    transcripts: list[str] = []
    for item in media:
        raw = item.get("raw")
        encoded = item.get("b64")
        if item.get("type") != "audio" or (not isinstance(raw, bytes) and not encoded):
            continue
        try:
            if not isinstance(raw, bytes):
                raw = base64.b64decode(encoded, validate=True)
        except Exception as exc:
            raise ValueError("音频数据编码无效") from exc
        if len(raw) > _MAX_BYTES:
            raise ValueError("MiniMax ASR 音频文件不能超过 50 MB")
        mime = str(item.get("mime") or "application/octet-stream").split(";", 1)[0].lower()
        formatted = _audio_format(item, mime)
        if mime in {"audio/pcm", "audio/l16", "audio/x-pcm"}:
            raise ValueError("MiniMax ASR 不支持无容器的 PCM 音频")
        from app.core.media_transcode import probe_duration
        source_ext = str(item.get("ext") or (formatted[0] if formatted else "")).lower().lstrip(".") or None
        duration = await asyncio.to_thread(probe_duration, raw, source_ext, precision=3)
        if duration is None:
            raise ValueError("无法确认音频时长；请确保 ffprobe 可用后重试")
        if duration > _MAX_SECONDS:
            raise ValueError("MiniMax ASR 音频时长不能超过 500 秒")
        if formatted is None:
            raw = await to_wav(raw)
            if raw is None:
                continue
            ext, upload_mime = "wav", "audio/wav"
        else:
            ext, upload_mime = formatted
        if len(raw) > _MAX_BYTES:
            raise ValueError("转码后的音频文件超过 MiniMax ASR 的 50 MB 限制")
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0), follow_redirects=False) as client:
                response = await client.post(
                    endpoint,
                    headers={"Authorization": f"Bearer {api_key}"},
                    data={"model": getattr(vm, "model", "asr-1.0") or "asr-1.0",
                          "response_format": "json", "stream": "false"},
                    files={"file": (f"audio.{ext}", raw, upload_mime)},
                )
                response.raise_for_status()
            payload = response.json()
            base_resp = payload.get("base_resp") if isinstance(payload, dict) else None
            if isinstance(base_resp, dict) and str(base_resp.get("status_code", "0")) not in {"", "0"}:
                raise httpx.HTTPStatusError(
                    "MiniMax ASR 返回上游错误",
                    request=response.request,
                    response=response,
                )
            text = payload.get("text")
            if not isinstance(text, str):
                raise ValueError("MiniMax ASR 返回缺少识别文本")
            transcripts.append(text.strip())
            logger.info("MiniMax 语音转写成功 model=%s chars=%d", vm.model, len(text.strip()))
        except Exception as exc:
            if log_transcription_error("agent.voice.minimax_asr", exc, defer=raise_errors) is None:
                diag_log("agent.voice.minimax_asr", exc)
                logger.warning("MiniMax ASR 转写失败：%s", redact(f"{type(exc).__name__}: {exc}"))
            if raise_errors:
                raise
            return ""
    return "\n".join(text for text in transcripts if text)
