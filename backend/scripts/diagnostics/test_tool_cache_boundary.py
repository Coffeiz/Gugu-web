#!/usr/bin/env python3
"""验证 OpenAI 兼容模型在工具轮之后是否推进 prompt cache。

只输出模型、输入 token、cache read 和 fresh input，不输出提示词、工具结果或密钥。
脚本使用当前 devserver 配置中的 ``settings.ai``，不要把结果当成业务请求发送。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from typing import Any


@dataclass
class Usage:
    input_tokens: int = 0
    cache_read: int = 0
    output_tokens: int = 0


def _usage_from_chunk(chunk: Any) -> Usage | None:
    raw = getattr(chunk, "usage", None)
    if raw is None:
        return None
    details = getattr(raw, "prompt_tokens_details", None)
    cached = getattr(details, "cached_tokens", 0) if details else 0
    return Usage(
        input_tokens=int(getattr(raw, "prompt_tokens", 0) or 0),
        cache_read=int(
            getattr(raw, "prompt_cache_hit_tokens", 0)
            or getattr(raw, "cache_read_input_tokens", 0)
            or cached
            or 0
        ),
        output_tokens=int(getattr(raw, "completion_tokens", 0) or 0),
    )


async def _call(client: Any, model: str, messages: list[dict[str, Any]]) -> Usage:
    stream = await client.chat.completions.create(
        model=model,
        messages=messages,
        tools=[{
            "type": "function",
            "function": {
                "name": "diagnostic_tool",
                "description": "仅用于缓存边界测试，不执行任何真实操作。",
                "parameters": {"type": "object", "properties": {}},
            },
        }],
        tool_choice="auto",
        max_tokens=8,
        temperature=0,
        stream=True,
        stream_options={"include_usage": True},
    )
    usage = Usage()
    async for chunk in stream:
        current = _usage_from_chunk(chunk)
        if current is not None:
            usage = current
    return usage


def _text_block(text: str, *, checkpoint: bool = False) -> dict[str, Any]:
    block: dict[str, Any] = {"type": "text", "text": text}
    if checkpoint:
        block["cache_control"] = {"type": "ephemeral"}
    return block


def _tool_result(text: str, *, checkpoint: bool) -> dict[str, Any]:
    return {
        "role": "tool",
        "tool_call_id": "diag-call-1",
        "content": [_text_block(text, checkpoint=checkpoint)],
    }


def _assistant_tool_call(call_id: str = "diag-call-1", tool_name: str = "diagnostic_tool") -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "id": call_id,
            "type": "function",
            "function": {"name": tool_name, "arguments": "{}"},
        }],
    }


def _prefix(size: int) -> str:
    seed = (
        "这是用于 prompt cache 边界测试的稳定前缀。它不代表真实用户内容，"
        "只用于保持多次请求的前缀完全一致。请不要复述这段内容。\n"
    )
    return (seed * ((size // len(seed)) + 1))[:size]


def _report(label: str, usage: Usage) -> None:
    fresh = max(usage.input_tokens - usage.cache_read, 0)
    ratio = usage.cache_read / usage.input_tokens if usage.input_tokens else 0
    print(json.dumps({
        "case": label,
        "input_tokens": usage.input_tokens,
        "cache_read": usage.cache_read,
        "fresh_input": fresh,
        "cache_ratio": round(ratio, 4),
        "output_tokens": usage.output_tokens,
    }, ensure_ascii=False))


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix-chars", type=int, default=24000)
    args = parser.parse_args()

    sys.path.insert(0, ".")
    import httpx
    from app.core.config import get_settings
    from agent import providers
    from agent.llm.llm_select import pick_model, use_anthropic_for

    settings = get_settings()
    # 与真实 Agent 一致，优先使用后台当前 active preset，而不是顶层旧配置。
    ai = pick_model(settings)
    if use_anthropic_for(ai):
        raise SystemExit("当前 active preset 走 Anthropic 格式，请切到 Kimi/Qwen 等 OpenAI 兼容 preset 后再运行")
    client = providers.build_openai_client(
        ai, httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
    )
    model = getattr(ai, "model", "")
    print(json.dumps({
        "provider": getattr(ai, "provider", ""),
        "model": model,
        "prefix_chars": args.prefix_chars,
    }, ensure_ascii=False))

    stable = _prefix(args.prefix_chars)
    system = {"role": "system", "content": [_text_block(stable, checkpoint=True)]}

    # 第一请求建立稳定 system + 普通 user 的基线缓存。
    base = [system, {"role": "user", "content": [_text_block("开始诊断", checkpoint=True)]}]
    _report("baseline", await _call(client, model, base))

    # 当前实现的边界：工具结果本身是最后一个带 checkpoint 的消息。
    direct_tool = base + [
        _assistant_tool_call(),
        _tool_result("第一份工具结果：用于缓存边界诊断。", checkpoint=True),
    ]
    _report("tool-result-checkpoint", await _call(client, model, direct_tool))

    direct_tool_2 = direct_tool + [
        _assistant_tool_call("diag-call-2", "diagnostic_tool_2"),
        {
            "role": "tool",
            "tool_call_id": "diag-call-2",
            "content": [_text_block("第二份工具结果：用于检查缓存是否继续增长。", checkpoint=True)],
        },
    ]
    _report("tool-result-checkpoint-2", await _call(client, model, direct_tool_2))

    # 对照组：工具结果后增加 user 边界，检查 provider 是否只在 user/assistant 边界推进缓存。
    user_boundary = base + [
        _assistant_tool_call("diag-call-2"),
        _tool_result("第一份工具结果：用于缓存边界诊断。", checkpoint=False),
        {"role": "user", "content": [_text_block("工具结果已返回，请继续处理。", checkpoint=True)]},
    ]
    _report("user-boundary-after-tool", await _call(client, model, user_boundary))


if __name__ == "__main__":
    asyncio.run(main())
