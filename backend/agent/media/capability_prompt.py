"""按当前模型与用户语音配置生成稳定的媒体能力 system 区块。"""
from __future__ import annotations

from agent.media import audio, gates
from agent.voice_config import VoiceRecognitionProfile, voice_recognition_profile
from app.core.chat_attach.file_types import AUDIO_EXTS, VIDEO_EXTS


def _mb(value: int) -> str:
    return f"{value / 1_000_000:g} MB"


def _seconds(value: float) -> str:
    return f"{value:g} 秒"


def media_capability_system_block(model_cfg, voice_profile: VoiceRecognitionProfile) -> str:
    """描述当前模型与语音配置的媒体输入路径和已知规格。"""
    lines = [
        "## 当前模型与语音识别配置的媒体能力",
        "以下规格来自当前模型/API 协议和语音识别配置；读取器仍会逐文件校验，工具回执是最终结果。",
    ]
    native_audio_exts = audio.native_audio_extensions(model_cfg)
    lines.extend(_audio_capability_lines(model_cfg, voice_profile, native_audio_exts))
    lines.append(_video_capability_line(model_cfg))
    lines.append("不要猜测未知规格或反复提交相同文件；超限、无法确认规格和服务故障以工具返回的具体原因处理。")
    return "\n".join(lines)


async def media_capability_for_user(model_cfg, user_id, *, db=None):
    """按当前模型和用户语音配置生成稳定的 system 能力说明。"""
    profile = (
        await voice_recognition_profile(user_id, db=db) if db is not None
        else await voice_recognition_profile(user_id)
    )
    return media_capability_system_block(model_cfg, profile)


def _audio_capability_lines(model_cfg, voice_profile, native_audio_exts) -> list[str]:
    lines = []
    if native_audio_exts:
        limits = gates.media_limits_for(model_cfg)
        formats = ", ".join(f".{ext}" for ext in sorted(native_audio_exts))
        lines.append(
            f"- 原生音频输入：当前主模型可直接接收 {formats}，单文件不超过 "
            f"{_mb(limits.audio_max_bytes)}；未声明时长上限。"
        )
    if voice_profile.configured:
        duration = (
            f"，时长不超过 {_seconds(voice_profile.max_duration_s)}"
            if voice_profile.max_duration_s is not None
            else "，服务未声明可用的时长上限"
        )
        lines.append(
            f"- 语音转写：当前 {voice_profile.provider_label or '语音识别服务'} 可处理常见音频格式，单文件不超过 "
            f"{_mb(voice_profile.max_file_bytes)}{duration}。"
        )
    elif voice_profile.resolved:
        lines.append("- 语音转写：当前没有可用的语音识别配置。")
    else:
        lines.append("- 语音转写：当前配置状态无法确认，不要假设识别服务可用。")

    if not native_audio_exts and voice_profile.resolved and not voice_profile.configured:
        lines.append("- 音频读取：当前没有可用的原生音频或语音转写路径。")
    elif not native_audio_exts and not voice_profile.configured:
        lines.append("- 音频读取：当前语音识别配置无法确认，不能假设音频可处理。")
    elif native_audio_exts or voice_profile.configured:
        accepted = ", ".join(f".{ext}" for ext in sorted(AUDIO_EXTS))
        lines.append(f"- read_file 音频文件类型：{accepted}；超出当前路径支持范围时以工具错误为准。")
    return lines


def _video_capability_line(model_cfg) -> str:
    if gates.video_enabled(model_cfg):
        limits = gates.media_limits_for(model_cfg)
        video_types = ", ".join(sorted(limits.video_mimes)) or ", ".join(
            f".{ext}" for ext in sorted(VIDEO_EXTS)
        )
        duration = (
            f"{_seconds(limits.max_duration_s)}"
            if limits.max_duration_s is not None else "未声明"
        )
        return (
            f"- 原生视频输入：当前主模型/API 协议已启用；格式 {video_types}；"
            f"单文件不超过 {_mb(limits.video_source_max_bytes)}，时长上限 {duration}。"
        )
    return "- 视频读取：当前主模型/API 协议未启用原生视频输入。"
