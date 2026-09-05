"""ContextBranch 共用的 provider 调用器。

只负责 provider 路由、调用参数和结果解析；领域写入仍由上层负责，用量则通过当前
用户链路上下文写入统一账本；反思与压缩均通过 ``ContextBranch`` 调用这里。
"""
from __future__ import annotations

import json


async def complete_text(sys: str, user: str, settings, max_tokens: int | None = 800) -> str:
    from agent.llm.llm_select import use_anthropic_for
    from agent.llm.modelctx import effective_ai

    ai = effective_ai(settings)
    use_anthropic = use_anthropic_for(ai)
    thinking = getattr(ai, "thinking", None)
    return (
        await _anthropic(sys, user, ai, max_tokens, thinking=thinking, settings=settings)
        if use_anthropic
        else await _openai(sys, user, ai, max_tokens, thinking=thinking, settings=settings)
    )


async def complete_json(
    sys: str,
    user: str,
    settings,
    max_tokens: int | None = 1500,
    thinking: str | None = None,
) -> dict:
    from agent.llm.llm_select import use_anthropic_for
    from agent.llm.modelctx import effective_ai

    ai = effective_ai(settings)
    use_anthropic = use_anthropic_for(ai)
    # 分支不覆盖模型配置；只有显式传入时才允许调用方临时指定。
    effective_thinking = (
        thinking if thinking is not None else getattr(ai, "thinking", None)
    )
    text = (
        await _anthropic(sys, user, ai, max_tokens, thinking=effective_thinking, settings=settings)
        if use_anthropic
        else await _openai(sys, user, ai, max_tokens, json_mode=True,
                           thinking=effective_thinking, settings=settings)
    )
    return _parse_json(text)


async def _anthropic(
    sys: str,
    user: str,
    ai,
    max_tokens: int | None,
    thinking: str | None = None,
    settings=None,
) -> str:
    import httpx
    from agent import providers

    client = providers.build_anthropic_client(
        ai, httpx.Timeout(connect=10.0, read=40.0, write=10.0, pool=5.0))
    # Anthropic API 必填 max_tokens，无法真正不限；None 时给高预算。
    if max_tokens is None:
        max_tokens = 32768
    # temperature 已全局下线（anthropic SDK 1.x 不再接受该参数）。
    kwargs = dict(
        model=ai.model,
        system=sys,
        messages=[{"role": "user", "content": user}],
        max_tokens=max_tokens,
    )
    if thinking is not None:
        kwargs["thinking"] = {"type": thinking}
    resp = await client.messages.create(**kwargs)
    usage = getattr(resp, "usage", None)
    from agent.usage import normalize_anthropic_usage
    await _record_usage(settings, ai, normalize_anthropic_usage(usage))
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")


async def _openai(
    sys: str,
    user: str,
    ai,
    max_tokens: int | None,
    json_mode: bool = False,
    thinking: str | None = None,
    settings=None,
) -> str:
    import httpx
    from agent import providers

    client = providers.build_openai_client(
        ai, httpx.Timeout(connect=10.0, read=40.0, write=10.0, pool=5.0))
    # max_tokens 为 None 表示不限制输出预算，交给 provider 使用模型默认上限。
    kwargs = dict(
        model=ai.model,
        messages=[{"role": "system", "content": sys}, {"role": "user", "content": user}],
    )
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    adapter = providers.adapter_for(ai)
    if json_mode:
        kwargs.update(adapter.build_structured_output(ai))
    if thinking is not None:
        thinking_params = adapter.build_openai_thinking_kwargs(
            ai, thinking=thinking)
        if thinking_params:
            kwargs.update(thinking_params)
    resp = await client.chat.completions.create(**kwargs)
    usage = getattr(resp, "usage", None)
    from agent.usage import normalize_openai_usage
    await _record_usage(settings, ai, normalize_openai_usage(usage))
    return resp.choices[0].message.content or ""


async def _record_usage(settings, model_cfg, usage: dict) -> None:
    """用量记账失败不能改变反思/压缩的业务结果。"""
    try:
        from agent.usage import record_current_usage

        await record_current_usage(settings, model_cfg, usage)
    except Exception as exc:
        # provider_runner 的调用方只关心模型结果；记账故障由诊断日志和后续重试处理。
        from app.core.redaction import diag_log
        diag_log("agent.usage.provider", exc)


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
