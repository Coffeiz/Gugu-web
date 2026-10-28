#!/usr/bin/env python3
"""探测强制 tool_choice 在各 provider 上的接受度、工具产出与缓存影响。

回答三个问题：

1. provider 是否接受强制 tool_choice（不 400）？
2. 强制之后模型是否真的产出目标工具调用？
3. 强制是否破坏 prompt cache（前缀命中是否塌陷）？

每个 provider 的调用序列固定为：

    warmup(auto) × N  →  auto  →  forced  →  required  →  auto(回归)

序列中间的 auto 基线和末尾的 auto 回归用于判断：强制只是「不命中」，
还是把后续轮次的缓存一起带崩。Anthropic 格式额外跑一组带/不带 thinking
（强制工具与自适应思考的关系在官方文档里有明确限制）。

脚本会真实调用线上模型，必须显式传入 --allow-real-llm。
输出只含量化指标、状态码和合成工具参数，不输出 API Key、提示词正文或真实用户内容。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass, field
from typing import Any


TOOL_NAME = "group_reply_decision"

_TOOL_DESCRIPTION = "决定本轮群聊是否需要咕咕回复；必须在任何正文或业务工具之前调用一次。"
_TOOL_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "should_reply": {"type": "boolean", "description": "需要回复时为 true，否则为 false"},
    },
    "required": ["should_reply"],
    "additionalProperties": False,
}

TOOL_SCHEMA_ANTHROPIC = {
    "name": TOOL_NAME,
    "description": _TOOL_DESCRIPTION,
    "input_schema": _TOOL_INPUT_SCHEMA,
}

TOOL_SCHEMA_OPENAI = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": _TOOL_DESCRIPTION,
        "parameters": _TOOL_INPUT_SCHEMA,
    },
}

# 合成群消息：不含任何真实用户内容。
GROUP_MESSAGE = "群里有人说：帮我看看这个功能怎么用？"


@dataclass
class Probe:
    """一次请求的量化结果。"""

    label: str = ""
    tool_choice: str = ""
    thinking_mode: str = ""
    ok: bool = False
    status: str = ""
    input_tokens: int = 0
    cache_read: int = 0
    output_tokens: int = 0
    tool_called: bool = False
    tool_args: str = ""
    error: str = ""

    def row(self) -> dict[str, Any]:
        ratio = self.cache_read / self.input_tokens if self.input_tokens else 0.0
        return {
            "label": self.label,
            "thinking_mode": self.thinking_mode,
            "tool_choice": self.tool_choice,
            "ok": self.ok,
            "status": self.status,
            "input_tokens": self.input_tokens,
            "cache_read": self.cache_read,
            "cache_ratio": round(ratio, 4),
            "output_tokens": self.output_tokens,
            "tool_called": self.tool_called,
            "tool_args": self.tool_args,
            "error": self.error,
        }


def _stable_prefix(size: int) -> str:
    """固定长度的合成前缀；只用于把缓存前缀撑到可观测的长度。"""
    seed = (
        "以下是为 prompt cache 边界诊断准备的稳定前缀文本，不包含任何真实用户内容，"
        "也不要复述其中任何句子。\n"
    )
    return (seed * ((size // len(seed)) + 1))[:size]


def _status_of(exc: Exception) -> str:
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    return str(status) if status else type(exc).__name__


def _short_error(exc: Exception) -> str:
    text = str(exc).replace("\n", " ").strip()
    return text[:220]


async def _call_openai(
    client: Any,
    model: str,
    prefix: str,
    tools: list[dict],
    tool_choice: Any,
    think_kwargs: dict | None = None,
) -> Probe:
    probe = Probe(tool_choice=json.dumps(tool_choice, ensure_ascii=False) if not isinstance(tool_choice, str) else tool_choice)
    messages = [
        {"role": "system", "content": prefix},
        {"role": "user", "content": GROUP_MESSAGE},
    ]
    kwargs: dict[str, Any] = dict(
        model=model,
        messages=messages,
        tools=tools,
        tool_choice=tool_choice,
        max_tokens=256,
    )
    if think_kwargs:
        kwargs.update(think_kwargs)
    try:
        resp = await client.chat.completions.create(**kwargs)
    except Exception as exc:  # noqa: BLE001 - 诊断脚本需要把失败原样报出来
        probe.status = _status_of(exc)
        probe.error = _short_error(exc)
        return probe

    usage = getattr(resp, "usage", None)
    if usage is not None:
        probe.input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        details = getattr(usage, "prompt_tokens_details", None)
        cached = getattr(details, "cached_tokens", 0) if details else 0
        probe.cache_read = int(getattr(usage, "prompt_cache_hit_tokens", 0) or cached or 0)
        probe.output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)

    choices = getattr(resp, "choices", None) or []
    if choices:
        tool_calls = getattr(getattr(choices[0], "message", None), "tool_calls", None) or []
        if tool_calls:
            probe.tool_called = True
            first = tool_calls[0]
            probe.tool_args = str(getattr(getattr(first, "function", None), "arguments", "") or "")[:120]
    probe.ok = True
    probe.status = "200"
    return probe


async def _call_anthropic(
    client: Any,
    model: str,
    prefix: str,
    tools: list[dict],
    tool_choice: Any,
    thinking_params: dict | None = None,
    use_cache_anchor: bool = True,
) -> Probe:
    probe = Probe(tool_choice=json.dumps(tool_choice, ensure_ascii=False) if not isinstance(tool_choice, str) else tool_choice)
    if use_cache_anchor:
        system: Any = [{"type": "text", "text": prefix, "cache_control": {"type": "ephemeral"}}]
    else:
        system = prefix
    kwargs: dict[str, Any] = dict(
        model=model,
        system=system,
        messages=[{"role": "user", "content": GROUP_MESSAGE}],
        tools=tools,
        tool_choice=tool_choice,
        max_tokens=1024,
    )
    if thinking_params:
        kwargs.update(thinking_params)
    try:
        resp = await client.messages.create(**kwargs)
    except Exception as exc:  # noqa: BLE001 - 诊断脚本需要把失败原样报出来
        probe.status = _status_of(exc)
        probe.error = _short_error(exc)
        return probe

    usage = getattr(resp, "usage", None)
    if usage is not None:
        probe.input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
        probe.cache_read = int(getattr(usage, "cache_read_input_tokens", 0) or 0)
        probe.output_tokens = int(getattr(usage, "output_tokens", 0) or 0)

    for block in getattr(resp, "content", None) or []:
        if getattr(block, "type", None) == "tool_use":
            probe.tool_called = True
            probe.tool_args = str(getattr(block, "input", "") or "")[:120]
            break
    probe.ok = True
    probe.status = "200"
    return probe


def _tool_choice_variants(anthropic_mode: bool) -> dict[str, Any]:
    """两种协议的 tool_choice 形状不同，混用会被 provider 当成非法参数拒掉。

    Anthropic 用扁平形状（type=tool 时直接给 name），OpenAI 兼容端用嵌套形状。
    """
    if anthropic_mode:
        return {
            "auto": {"type": "auto"},
            "forced": {"type": "tool", "name": TOOL_NAME},
            "any": {"type": "any"},
        }
    return {
        "auto": "auto",
        "forced": {"type": "function", "function": {"name": TOOL_NAME}},
        "required": "required",
    }


async def probe_preset(ai: Any, args, thinking_mode: str) -> list[dict[str, Any]]:
    """对一个 preset 跑完整调用序列，返回逐行结果。"""
    import httpx

    from agent import providers
    from agent.llm.llm_select import use_anthropic_for

    anthropic_mode = use_anthropic_for(ai)
    timeout = httpx.Timeout(connect=10.0, read=120.0, write=20.0, pool=5.0)
    adapter = providers.adapter_for(ai)
    model = getattr(ai, "model", "") or ""
    variants = _tool_choice_variants(anthropic_mode)

    if anthropic_mode:
        client = providers.build_anthropic_client(ai, timeout)
        tools = [TOOL_SCHEMA_ANTHROPIC]
        thinking_params = adapter.build_anthropic_thinking_params(ai)

        async def call(choice: Any, prefix: str) -> Probe:
            return await _call_anthropic(
                client, model, prefix, tools, choice, thinking_params,
            )
    else:
        client = providers.build_openai_client(ai, timeout)
        tools = [TOOL_SCHEMA_OPENAI]
        think_kwargs = adapter.build_openai_thinking_kwargs(ai)

        async def call(choice: Any, prefix: str) -> Probe:
            return await _call_openai(
                client, model, prefix, tools, choice, think_kwargs,
            )

    prefix = _stable_prefix(args.prefix_chars)
    rows: list[dict[str, Any]] = []

    def emit(probe: Probe, label: str) -> None:
        probe.label = label
        probe.thinking_mode = thinking_mode
        rows.append(probe.row())

    # 预热：建立前缀缓存。forced/required 的对比全部基于已热的前缀。
    for index in range(args.warmup):
        probe = await call(variants["auto"], prefix)
        emit(probe, f"warmup-{index + 1}")

    emit(await call(variants["auto"], prefix), "baseline-auto")
    emit(await call(variants["forced"], prefix), "forced")
    # Anthropic 协议没有 "required"，等价形态是 {"type":"any"}。
    emit(await call(variants.get("required") or variants["any"], prefix), "required-or-any")
    emit(await call(variants["auto"], prefix), "regression-auto")

    return rows


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-real-llm", action="store_true", help="确认真实调用线上模型")
    parser.add_argument("--presets", default="", help="逗号分隔的 preset 名或 id；默认全部")
    parser.add_argument("--warmup", type=int, default=2, help="预热轮数")
    parser.add_argument("--prefix-chars", type=int, default=30000, help="合成前缀字符数")
    args = parser.parse_args()

    if not args.allow_real_llm:
        raise SystemExit("诊断脚本会真实调用线上模型；确认后加 --allow-real-llm 重新运行。")

    sys.path.insert(0, ".")
    from app.core.config import get_settings
    from agent import providers
    from agent.llm.llm_select import use_anthropic_for

    settings = get_settings()
    items = list(getattr(getattr(settings, "ai_presets", None), "items", None) or [])
    wanted = {part.strip() for part in args.presets.split(",") if part.strip()}

    for preset in items:
        name = getattr(preset, "name", "") or ""
        pid = getattr(preset, "id", "") or ""
        if wanted and name not in wanted and pid not in wanted:
            continue
        if not getattr(preset, "api_key", ""):
            print(json.dumps({"preset": name, "skipped": "no_api_key"}, ensure_ascii=False))
            continue

        header = {
            "preset": name,
            "provider": getattr(preset, "provider", ""),
            "model": getattr(preset, "model", ""),
            "api_format": "anthropic" if use_anthropic_for(preset) else "openai",
            "thinking_configured": getattr(preset, "thinking", ""),
        }

        # thinking 开关是强制 tool_choice 的关键变量：不少 provider 在思考模式下
        # 直接拒收强制 tool_choice，所以每个 preset 跑「按配置」和「关闭思考」两组。
        variants = [("as-configured", preset)]
        if getattr(preset, "thinking", "") != "disabled":
            variants.append(("disabled", preset.model_copy(update={"thinking": "disabled"})))

        # provider 若同时提供 Anthropic 兼容端，单独测一遍：两种协议的 tool_choice
        # 形状和限制不同（Anthropic 用扁平的 type/name），不能互相推断。
        adapter = providers.adapter_for(preset)
        try:
            supported = adapter.supported_api_formats(preset)
        except Exception:  # noqa: BLE001 - 能力探测失败不该中断整个探针
            supported = ()
        if "anthropic" in supported and adapter.protocol_format(preset) != "anthropic":
            anthropic_ai = preset.model_copy(update={"api_format": "anthropic"})
            anthropic_ai = anthropic_ai.model_copy(
                update={"base_url": adapter.default_base_url_for(anthropic_ai)}
            )
            variants.append(("anthropic-endpoint", anthropic_ai))

        for thinking_mode, target in variants:
            row_header = dict(header, thinking_mode=thinking_mode)
            print(json.dumps(row_header, ensure_ascii=False), flush=True)
            try:
                for row in await probe_preset(target, args, thinking_mode):
                    print(json.dumps(row, ensure_ascii=False), flush=True)
            except Exception as exc:  # noqa: BLE001 - 单个 preset 失败不影响其余
                print(json.dumps({
                    "preset": name,
                    "thinking_mode": thinking_mode,
                    "fatal": f"{type(exc).__name__}: {_short_error(exc)}",
                }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
