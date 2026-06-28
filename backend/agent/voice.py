"""语音 / 音视频识别（转写）——用独立配置的「语音模型」把 media 转成文字，与主模型解耦。

设计：收到语音/音视频这轮，**不再强切主模型到 mimo**，而是用 `settings.voice` 这个独立模型
把音频转成纯文字，把文字并进用户消息 → 主模型（settings.ai / pool 选的那个）照常处理。
- 未配置语音模型（`settings.voice.model` 为空）→ `transcribe` 返回 **None**，调用方据此切断、回「不支持」。
- 配置了但转写失败/空 → 返回空串 `""`，调用方注入一句「没听清」兜底，仍交主模型（不报错）。

固定走 **OpenAI 兼容方式**（chat + `input_audio` base64）：纯 ASR 模型只送音频块、不加文字指令；
返回 `choices[0].message.content` 即转写文本。模型需支持 input_audio（qwen3-asr-flash / mimo 系等）。
"""
from __future__ import annotations

import logging
from types import SimpleNamespace

logger = logging.getLogger("agent.voice")


def _vm(settings):
    """取语音模型配置，兼容它是 VoiceSettings 对象或 dict（不同加载路径下可能是 dict）。"""
    v = getattr(settings, "voice", None)
    return SimpleNamespace(**v) if isinstance(v, dict) else v


def is_configured(settings) -> bool:
    """是否配置了语音识别模型。"""
    vm = _vm(settings)
    return bool(vm and (getattr(vm, "model", "") or "").strip())


async def transcribe(media: list, settings) -> str | None:
    """把 media（[{type:'audio'|'video', mime, b64}]）转成文字。
    返回 None = 未配置语音模型（调用方切断回「不支持」）；返回 str = 转写结果（可能为空串）。"""
    vm = _vm(settings)
    if not vm or not (getattr(vm, "model", "") or "").strip():
        return None
    # 只送音频块（纯 ASR，不加 text 指令）；base64 内联走 data URL（与现有 mimo input_audio 同格式）
    parts = []
    for m in (media or []):
        if m.get("type") == "audio" and m.get("b64"):
            data_url = f"data:{m.get('mime') or 'audio/mpeg'};base64,{m['b64']}"
            parts.append({"type": "input_audio", "input_audio": {"data": data_url}})
    if not parts:
        logger.info("转写跳过：media 里没有 audio 块（types=%s）", [m.get("type") for m in (media or [])])
        return ""   # 没有可转写的音频（如纯视频）→ 调用方兜底为「没听清」
    from agent.llm_select import openai_default_headers
    try:
        import httpx
        from openai import AsyncOpenAI
        client = AsyncOpenAI(
            api_key=getattr(vm, "api_key", "") or "dummy", base_url=getattr(vm, "base_url", ""),
            timeout=httpx.Timeout(60.0), default_headers=openai_default_headers(vm))
        # ASR 模型（mimo-v2.5-asr / qwen3-asr-flash）干净调用即可——**不传 thinking**（那是聊天模型的，
        # ASR 模型会拒）；语言等用默认自动识别（如需指定可加 extra_body={"asr_options": {"language": "zh"}}）。
        resp = await client.chat.completions.create(
            model=vm.model, messages=[{"role": "user", "content": parts}])
        out = (resp.choices[0].message.content or "").strip()
        logger.info("语音转写成功 model=%s → %d 字: %s", vm.model, len(out), out[:80])
        return out
    except Exception as e:
        # 失败回空串（调用方兜底为「没听清」），但**打日志**——别再静默吞错（model 名错/端点错/鉴权都靠它排查）
        logger.warning("语音转写失败 model=%s base_url=%s → %s: %s",
                       getattr(vm, "model", "?"), getattr(vm, "base_url", "?"), type(e).__name__, str(e)[:300])
        return ""
