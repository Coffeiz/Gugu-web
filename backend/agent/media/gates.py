"""媒体能力门：当前模型能不能看图 / 听音 / 看视频，以及对应的 Provider 媒体限制。

这一层只做「能力判定」，不做任何媒体处理——压缩、转码、封块在
`images.py` / `video.py`。判定依据全部来自 Provider 适配器声明（`agent.providers`），
规格跟随 Provider，不在本模块硬编码任何厂商细节。
"""
from __future__ import annotations

from agent.providers.media import MediaLimits


def image_enabled(model_cfg=None) -> bool:
    """当前模型是否支持图片输入。

    保留后台探测/手动开关和能力覆写，同时信任适配器已登记的模型能力，
    避免新建预设还没点检测时把图片误当普通附件。
    """
    try:
        from app.core.config import get_settings
        from agent import providers
        ai = model_cfg or get_settings().ai
        capabilities = providers.adapter_for(ai).capabilities(getattr(ai, "model", "") or "")
        overrides = getattr(ai, "capability_overrides", None) or {}
        image_capability = overrides.get("image")
        if not isinstance(image_capability, bool):
            image_capability = capabilities.image
        return bool(getattr(ai, "image", False)) or image_capability
    except Exception:
        return False


def video_enabled(model_cfg=None) -> bool:
    """视频理解是否开启：产品开关打开，且适配器为当前请求协议声明了视频能力。"""
    try:
        if model_cfg is not None:
            if not getattr(model_cfg, "video", False):
                return False
            return video_transport_for(model_cfg) != "none"
        from app.core.config import get_settings
        ai = get_settings().ai
        if not getattr(ai, "video", False):
            return False
        return video_transport_for(ai) != "none"
    except Exception:
        return False


def audio_enabled(model_cfg=None) -> bool:
    """音频理解是否开启：主模型 audio 开，且当前请求走 OpenAI Chat 格式。
    独立语音识别模型（ASR 转写）由语音配置单独判定，两者解耦。"""
    try:
        from agent import providers
        if model_cfg is not None:
            if not getattr(model_cfg, "audio", False):
                return False
            adapter = providers.adapter_for(model_cfg)
            if adapter.protocol_format(model_cfg) != "openai":
                return False
            # audio 是产品开关，不能越过 provider 的协议能力；否则 GLM
            # 等文本端点会收到 input_audio，并以 content.type 400 拒绝请求。
            return bool(providers.capability_snapshot(model_cfg).get("audio", False))
        from app.core.config import get_settings
        ai = get_settings().ai
        if not getattr(ai, "audio", False):
            return False
        adapter = providers.adapter_for(ai)
        if adapter.protocol_format(ai) != "openai":
            return False
        return bool(providers.capability_snapshot(ai).get("audio", False))
    except Exception:
        return False


def should_transcribe_audio(model_cfg=None) -> bool:
    """判断音频是否需要回退到独立语音识别模型。

    主模型具备原生音频能力时，音频应直接随本轮请求发送给主模型；只有
    主模型不支持音频时，才由独立语音识别模型转写成文字。
    """
    return not audio_enabled(model_cfg)


def minimax_video_enabled(model_cfg) -> bool:
    """兼容旧调用：查询适配器声明的 Anthropic 视频传输能力。"""
    from agent import providers
    adapter = providers.adapter_for(model_cfg)
    model = getattr(model_cfg, "model", "") or ""
    return adapter.media_transport(model) == "anthropic"


def media_limits_for(model_cfg=None) -> MediaLimits:
    """返回实际模型 Provider 的媒体策略；无专属策略时使用公共默认值。"""
    if model_cfg is None:
        try:
            from app.core.config import get_settings
            model_cfg = get_settings().ai
        except Exception:
            return MediaLimits()
    from agent import providers
    adapter = providers.adapter_for(model_cfg)
    return adapter.media_limits(getattr(model_cfg, "model", "") or "")


def video_transport_for(model_cfg) -> str:
    """返回当前模型的视频块协议；供聊天附件和 read_file 共用。"""
    from agent import providers
    adapter = providers.adapter_for(model_cfg)
    model = getattr(model_cfg, "model", "") or ""
    # 媒体块跟随本轮实际请求协议。Responses 目前没有视频输入块；Chat
    # 协议只要在该 Provider 的声明列表中，就按所选格式构造媒体内容。
    protocol = adapter.protocol_format(model_cfg)
    if protocol == "responses" or protocol not in adapter.supported_api_formats(model_cfg):
        return "none"
    overrides = getattr(model_cfg, "capability_overrides", None) or {}
    declared_video = overrides.get("video") if isinstance(overrides.get("video"), bool) \
        else adapter.supports_video(model)
    if not declared_video:
        return "none"
    return "anthropic" if protocol == "anthropic" else "openai"
