"""独立文本生成：按配置调用协议，只返回可见正文，不读写对话推理状态。"""
from __future__ import annotations

from agent.security.sanitize import strip_think_blocks


def output_budget(ai, requested: int | None) -> int | None:
    """短输出也为支持推理的模型预留预算；None 保持 provider 默认上限。"""
    if requested is None:
        return None
    from agent import providers

    adapter = providers.adapter_for(ai)
    capabilities = adapter.reasoning_capabilities(ai, adapter.protocol_format(ai))
    return max(requested, 4096) if capabilities.modes or capabilities.efforts else requested


async def complete_text(ai, prompt: str, *, max_tokens: int = 800,
                        timeout: float = 40.0) -> str:
    """供问候、会话元数据和邮件生成使用；用量仍由各业务入口负责。"""
    import httpx
    from agent import providers

    adapter = providers.adapter_for(ai)
    protocol = adapter.protocol_format(ai)
    budget = output_budget(ai, max_tokens)
    limits = httpx.Timeout(timeout)
    if protocol == "anthropic":
        async with providers.build_anthropic_client(ai, limits) as client:
            response = await client.messages.create(
                model=ai.model, max_tokens=budget,
                messages=[{"role": "user", "content": prompt}],
                **adapter.build_anthropic_thinking_params(ai))
        text = "".join(block.text for block in response.content if block.type == "text")
    else:
        async with providers.build_openai_client(ai, limits) as client:
            if protocol == "responses":
                from .openai_responses import _responses_output_text

                response = await client.responses.create(
                    model=ai.model, max_output_tokens=budget,
                    input=[{"role": "user", "content": prompt}],
                    **providers.responses_store_params(ai),
                    **adapter.build_responses_reasoning_params(ai))
                text = _responses_output_text(response)
            else:
                response = await client.chat.completions.create(
                    model=ai.model, max_tokens=budget,
                    messages=[{"role": "user", "content": prompt}],
                    **adapter.build_openai_thinking_kwargs(ai))
                text = response.choices[0].message.content or ""
    return strip_think_blocks(text).strip()
