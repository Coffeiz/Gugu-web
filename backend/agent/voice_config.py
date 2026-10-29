"""语音配置的公共规则：识别模型选择、输入规格解析，以及百炼原生协议的产品线判定。

这里只回答「用哪个识别模型、它最多能吃多少字节」；具体的转写请求实现留在
`agent/voice.py`，各识别 Provider 的规格与请求实现留在
`agent/providers/<provider>/asr.py`——规格跟随 Provider。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class VoiceRecognitionProfile:
    """本轮实际选中的语音识别服务输入规格。"""

    configured: bool
    max_file_bytes: int
    max_duration_s: float | None = None
    provider_label: str | None = None
    resolved: bool = True


def dashscope_service_for_model(model: str) -> str:
    name = model.strip().lower()
    for prefix, service in (("qwen3-asr", "qwen3-asr"), ("qwen-audio", "qwen-audio"), ("fun-asr", "fun-asr")):
        if name.startswith(prefix):
            return service
    raise ValueError("百炼原生语音模型须属于 Qwen3 ASR、Qwen-Audio 或 Fun-ASR 产品线")


def voice_recognition_enabled() -> bool:
    """是否配了独立「语音识别模型」（settings.voice）。配了就构建转写用的音频 media
    交给 agent.voice.transcribe 转写——**不管主模型支不支持音视频**（解耦的关键）。"""
    try:
        from app.core.config import get_settings
        from agent import voice as _voice
        return _voice.is_configured(get_settings())
    except Exception:
        return False


async def voice_recognition_spec(user_id, *, db=None) -> VoiceRecognitionProfile:
    """解析本轮语音识别路由及其已知输入限制。

    选谁：用户 BYOK 凭据优先，没配 BYOK 才看全局 ``settings.voice``。
    未声明的 Provider 限制保持为 ``None``，不推测其时长上限。
    """
    from agent.media.constants import MEDIA_RAW_MAX

    try:
        from app.core.config import get_settings
        from agent import voice as voice_agent
        settings = get_settings()
        if user_id is not None:
            from app.byok.policy import byok_enabled
            if byok_enabled():
                from app.byok.service import get_active_credential
                if db is not None:
                    credential = await get_active_credential(db, user_id, "speech_to_text")
                else:
                    import app.db.session as db_session
                    if db_session._engine is None:
                        db_session._build_engine()
                    async with db_session._SessionLocal() as credential_db:
                        credential = await get_active_credential(
                            credential_db, user_id, "speech_to_text",
                        )
                if credential is not None:
                    enabled = voice_agent.supports_configured_voice_model(credential)
                    if not enabled:
                        return VoiceRecognitionProfile(False, MEDIA_RAW_MAX)
                    api_format = (credential.api_format or "openai").strip().lower()
                    minimax_asr = bool(
                        enabled and credential.provider == "minimax" and api_format == "minimax-asr"
                    )
                    if minimax_asr:
                        from agent.providers.minimax.asr import MAX_DURATION_SECONDS, MAX_FILE_BYTES
                        return VoiceRecognitionProfile(
                            enabled, MAX_FILE_BYTES, MAX_DURATION_SECONDS, "MiniMax ASR",
                        )
                    return VoiceRecognitionProfile(
                        enabled, MEDIA_RAW_MAX, provider_label="语音识别服务",
                    )
        voice = voice_agent._vm(settings)
        if (voice_agent.is_configured(settings)
                and voice_agent.supports_configured_voice_model(voice)):
            minimax_asr = (getattr(voice, "api_format", "") or "").strip().lower() == "minimax-asr"
            if minimax_asr:
                from agent.providers.minimax.asr import MAX_DURATION_SECONDS, MAX_FILE_BYTES
                return VoiceRecognitionProfile(
                    True, MAX_FILE_BYTES, MAX_DURATION_SECONDS, "MiniMax ASR",
                )
            return VoiceRecognitionProfile(True, MEDIA_RAW_MAX, provider_label="语音识别服务")
        return VoiceRecognitionProfile(False, MEDIA_RAW_MAX)
    except Exception:
        return VoiceRecognitionProfile(False, MEDIA_RAW_MAX, resolved=False)


def normalize_voice_recognition_profile(value) -> VoiceRecognitionProfile:
    """接收规格对象，兼容已有调用桩返回的二元组。"""
    if isinstance(value, VoiceRecognitionProfile):
        return value
    configured, max_file_bytes = value
    return VoiceRecognitionProfile(bool(configured), int(max_file_bytes))


async def voice_recognition_profile(user_id, *, db=None) -> VoiceRecognitionProfile:
    """返回本轮实际语音识别配置及已知规格。"""
    return await voice_recognition_spec(user_id, db=db)
