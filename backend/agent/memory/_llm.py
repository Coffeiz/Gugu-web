"""记忆系统共用的轻量 LLM 调用。

复用 settings.ai 的 provider 做单次非流式调用，返回解析后的 JSON dict。
反思（reflection）与压缩（compress）共用，避免两处重复 provider 路由 + 解析。
"""
from __future__ import annotations

import json


async def complete_text(sys: str, user: str, settings, max_tokens: int = 800) -> str:
    """单次非流式调用 → 返回纯文本。失败返回空串。"""
    from agent.llm_select import use_anthropic_for
    use_anthropic = use_anthropic_for(settings.ai)
    try:
        return (
            await _anthropic(sys, user, settings, max_tokens)
            if use_anthropic
            else await _openai(sys, user, settings, max_tokens)
        )
    except Exception:
        return ""


async def complete_json(sys: str, user: str, settings, max_tokens: int = 500) -> dict:
    """单次非流式调用 → 解析 JSON。失败/解析不出返回 {}。"""
    from agent.llm_select import use_anthropic_for
    use_anthropic = use_anthropic_for(settings.ai)
    text = (
        await _anthropic(sys, user, settings, max_tokens)
        if use_anthropic
        else await _openai(sys, user, settings, max_tokens)
    )
    return _parse_json(text)


async def _anthropic(sys: str, user: str, settings, max_tokens: int) -> str:
    import httpx
    from anthropic import AsyncAnthropic

    from agent.llm_select import anthropic_default_headers
    client = AsyncAnthropic(
        api_key=settings.ai.api_key or "dummy",
        base_url=settings.ai.base_url,
        http_client=httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=40.0, write=10.0, pool=5.0)),
        default_headers=anthropic_default_headers(settings.ai),
    )
    resp = await client.messages.create(
        model=settings.ai.model,
        system=sys,
        messages=[{"role": "user", "content": user}],
        max_tokens=max_tokens,
        temperature=0.3,
    )
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")


async def _openai(sys: str, user: str, settings, max_tokens: int) -> str:
    import httpx
    from openai import AsyncOpenAI
    from agent.llm_select import openai_default_headers

    client = AsyncOpenAI(
        api_key=settings.ai.api_key or "dummy",
        base_url=settings.ai.base_url,
        timeout=httpx.Timeout(connect=10.0, read=40.0, write=10.0, pool=5.0),
        default_headers=openai_default_headers(settings.ai),
    )
    resp = await client.chat.completions.create(
        model=settings.ai.model,
        messages=[{"role": "system", "content": sys}, {"role": "user", "content": user}],
        max_tokens=max_tokens,
        temperature=0.3,
    )
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
