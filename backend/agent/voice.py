"""语音 / 音视频识别（转写）——用独立配置的「语音模型」把 media 转成文字，与主模型解耦。

设计：收到语音/音视频这轮，**不再强切主模型到 mimo**，而是用 `settings.voice` 这个独立模型
把音频转成纯文字，把文字并进用户消息 → 主模型（settings.ai / pool 选的那个）照常处理。
- 未配置语音模型（`settings.voice.model` 为空）→ `transcribe` 返回 **None**，调用方据此切断、回「不支持」。
- 配置了但转写失败/空 → 返回空串 `""`，调用方注入一句「没听清」兜底，仍交主模型（不报错）。

语音模型需支持 OpenAI 的 `input_audio` 扩展块（mimo 系）。
"""
from __future__ import annotations

_TRANSCRIBE_PROMPT = (
    "把这段语音 / 音频的内容**逐字转成纯文字**。只输出文字本身，"
    "不要任何解释、不要加引号、不要描述说话人或语气。听不出内容就回空。"
)


def is_configured(settings) -> bool:
    """是否配置了语音识别模型。"""
    vm = getattr(settings, "voice", None)
    return bool(vm and (getattr(vm, "model", "") or "").strip())


async def transcribe(media: list, settings) -> str | None:
    """把 media（[{type:'audio'|'video', mime, b64}]）转成文字。
    返回 None = 未配置语音模型（调用方切断回「不支持」）；返回 str = 转写结果（可能为空串）。"""
    vm = getattr(settings, "voice", None)
    if not vm or not (getattr(vm, "model", "") or "").strip():
        return None
    from app.core.chat_attach import build_user_content
    from agent.llm_select import _is_mimo, openai_default_headers
    content = build_user_content(_TRANSCRIBE_PROMPT, [], use_anthropic=False, media=media)
    try:
        import httpx
        from openai import AsyncOpenAI
        client = AsyncOpenAI(
            api_key=vm.api_key or "dummy", base_url=vm.base_url,
            timeout=httpx.Timeout(30.0), default_headers=openai_default_headers(vm))
        extra = {"extra_body": {"thinking": {"type": "disabled"}}} if _is_mimo(vm) else {}
        resp = await client.chat.completions.create(
            model=vm.model, max_tokens=1200,
            messages=[{"role": "user", "content": content}], **extra)
        return (resp.choices[0].message.content or "").strip()
    except Exception:
        return ""   # 配置了但调用失败 → 空串（调用方兜底为「没听清」，不当未配置）
