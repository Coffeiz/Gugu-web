"""语音配置的公共规则：识别模型选择、输入规格解析，以及百炼原生协议的产品线判定。

这里只回答「用哪个识别模型、它最多能吃多少字节」；具体的转写请求实现留在
`agent/voice.py`，各识别 Provider 的规格与请求实现留在
`agent/providers/<provider>/asr.py`——规格跟随 Provider。
"""
from __future__ import annotations


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


async def voice_recognition_profile(user_id) -> tuple[bool, int]:
    """返回语音识别是否可用及对应识别 Provider 的最大输入字节数。

    选谁：用户 BYOK 凭据优先，没配 BYOK 才看全局 `settings.voice`。
    上限：各 Provider 自己声明（MiniMax ASR 用 multipart 原始字节，可以走官方
    50 MiB 上限；其余路径沿用通用媒体字节门槛）。
    """
    from agent.media.constants import MEDIA_RAW_MAX

    try:
        from app.core.config import get_settings
        from agent import voice as voice_agent
        settings = get_settings()
        if user_id is not None:
            from app.byok.policy import byok_enabled
            if byok_enabled():
                import app.db.session as db_session
                if db_session._engine is None:
                    db_session._build_engine()
                from app.byok.service import get_active_credential
                async with db_session._SessionLocal() as db:
                    credential = await get_active_credential(db, user_id, "speech_to_text")
                if credential is not None:
                    enabled = bool(credential.model)
                    minimax_asr = bool(enabled and credential.provider == "minimax" and credential.api_format == "minimax-asr")
                    if minimax_asr:
                        from agent.providers.minimax.asr import MAX_FILE_BYTES
                        return enabled, MAX_FILE_BYTES
                    return enabled, MEDIA_RAW_MAX
        if voice_agent.is_configured(settings):
            voice = settings.voice
            minimax_asr = (getattr(voice, "api_format", "") or "").strip().lower() == "minimax-asr"
            if minimax_asr:
                from agent.providers.minimax.asr import MAX_FILE_BYTES
                return True, MAX_FILE_BYTES
            return True, MEDIA_RAW_MAX
        return False, MEDIA_RAW_MAX
    except Exception:
        return False, MEDIA_RAW_MAX
