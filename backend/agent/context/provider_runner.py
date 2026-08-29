"""ContextBranch 共用的 provider 调用器。

只负责 provider 路由、调用参数和结果解析；不负责记忆字段、session baseline 或
任何领域写入；反思与压缩均通过 ``ContextBranch`` 调用这里。
"""
from __future__ import annotations

import json


async def complete_text(sys: str, user: str, settings, max_tokens: int = 800) -> str:
    from agent.llm.llm_select import use_anthropic_for

    use_anthropic = use_anthropic_for(settings.ai)
    thinking = getattr(settings.ai, "thinking", None)
    return (
        await _anthropic(sys, user, settings, max_tokens, thinking=thinking)
        if use_anthropic
        else await _openai(sys, user, settings, max_tokens, thinking=thinking)
    )


async def complete_json(
    sys: str,
    user: str,
    settings,
    max_tokens: int = 1500,
    temperature: float = 0.3,
    thinking: str | None = None,
) -> dict:
    from agent.llm.llm_select import use_anthropic_for

    use_anthropic = use_anthropic_for(settings.ai)
    # 分支不覆盖模型配置；只有显式传入时才允许调用方临时指定。
    effective_thinking = (
        thinking if thinking is not None else getattr(settings.ai, "thinking", None)
    )
    text = (
        await _anthropic(
            sys, user, settings, max_tokens, temperature, thinking=effective_thinking
        )
        if use_anthropic
        else await _openai(
            sys, user, settings, max_tokens, temperature,
            json_mode=True, thinking=effective_thinking,
        )
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
    if thinking is not None:
        thinking_params = adapter.build_openai_thinking_kwargs(
            settings.ai, thinking=thinking)
        if thinking_params:
            kwargs.update(thinking_params)
    resp = await client.chat.completions.create(**kwargs)
    return resp.choices[0].message.content or ""


def _parse_json(text: str) -> dict:
    """从模型输出里提取 JSON 对象，容忍 markdown 围栏。"""
    if not text:
        return {}
    value = text.strip()
    if "```" in value:
        value = value.split("```", 2)[1]
        if value.startswith("json"):
            value = value[4:]
    lo, hi = value.find("{"), value.rfind("}")
    if lo == -1 or hi == -1:
        return {}
    try:
        parsed = json.loads(value[lo:hi + 1])
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}
