"""记忆系统共用的轻量 LLM 调用。

复用 settings.ai 的 provider 做单次非流式调用，返回解析后的 JSON dict。
反思（reflection）与压缩（compress）共用，避免两处重复 provider 路由 + 解析。
"""
from __future__ import annotations

import json


async def complete_text(sys: str, user: str, settings, max_tokens: int = 800) -> str:
    """单次非流式调用 → 返回纯文本。失败返回空串。"""
    from agent.llm.llm_select import use_anthropic_for
    use_anthropic = use_anthropic_for(settings.ai)
    try:
        return (
            await _anthropic(sys, user, settings, max_tokens)
            if use_anthropic
            else await _openai(sys, user, settings, max_tokens)
        )
    except Exception:
        return ""


async def complete_json(
    sys: str,
    user: str,
    settings,
    max_tokens: int = 1500,
    temperature: float = 0.3,
    thinking: str | None = None,
) -> dict:
    """单次非流式调用 → 解析 JSON。失败/解析不出返回 {}。
    ⚠️ max_tokens 太小会把 JSON 截断 → 解析失败静默返回 {}；要回显大内容（如反思回显整份
    pattern）的调用方必须按内容量调大 max_tokens（默认曾 500，导致老用户反思全静默，踩过大坑）。
    temperature 默认 0.3（跟反思/压缩一致）；判断稳定性要求高、容错低的调用方（如批量删除类）
    可传更低的值换取更一致的输出。"""
    from agent.llm.llm_select import use_anthropic_for
    use_anthropic = use_anthropic_for(settings.ai)
    text = (
        await _anthropic(sys, user, settings, max_tokens, temperature, thinking=thinking)
        if use_anthropic
        else await _openai(sys, user, settings, max_tokens, temperature, json_mode=True, thinking=thinking)
    )
    return _parse_json(text)


async def _anthropic(
    sys: str,
    user: str,
    settings,
    max_tokens: int,
    temperature: float = 0.3,
    thinking: str | None = None,
) -> str:
    import httpx
    from agent import providers

    client = providers.build_anthropic_client(
        settings.ai, httpx.Timeout(connect=10.0, read=40.0, write=10.0, pool=5.0))
    kwargs = dict(
        model=settings.ai.model,
        system=sys,
        messages=[{"role": "user", "content": user}],
        max_tokens=max_tokens,
        temperature=temperature,
    )
    if thinking is not None:
        kwargs["thinking"] = {"type": thinking}
    resp = await client.messages.create(**kwargs)
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")


async def _openai(
    sys: str,
    user: str,
    settings,
    max_tokens: int,
    temperature: float = 0.3,
    json_mode: bool = False,
    thinking: str | None = None,
) -> str:
    import httpx
    from agent import providers

    client = providers.build_openai_client(
        settings.ai, httpx.Timeout(connect=10.0, read=40.0, write=10.0, pool=5.0))
    kwargs = dict(
        model=settings.ai.model,
        messages=[{"role": "system", "content": sys}, {"role": "user", "content": user}],
        max_tokens=max_tokens,
        temperature=temperature,
    )
    adapter = providers.adapter_for(settings.ai)
    if json_mode:
        kwargs.update(adapter.build_structured_output(settings.ai))
    if json_mode or thinking is not None:
        thinking_params = adapter.build_thinking_params(
            settings.ai, thinking=thinking or ("disabled" if json_mode else None))
        if thinking_params:
            kwargs["extra_body"] = thinking_params
    resp = await client.chat.completions.create(**kwargs)
    return resp.choices[0].message.content or ""


def _parse_json(text: str) -> dict:
    """从模型输出里抠出 JSON 对象，容忍 ```json 围栏与前后杂字。"""
    if not text:
        return {}
    s = text.strip()
    if "```" in s:
        s = s.split("```")[1]
        if s.startswith("json"):
            s = s[4:]
    lo, hi = s.find("{"), s.rfind("}")
    if lo == -1 or hi == -1:
        return {}
    try:
        return json.loads(s[lo:hi + 1])
    except Exception:
        return {}
