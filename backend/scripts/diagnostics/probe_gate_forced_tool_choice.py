#!/usr/bin/env python3
"""探测群聊选择门那一轮的强制 tool_choice 对前缀缓存的影响。

线上真实序列是：

    第 1 轮（还没做选择）：thinking 关 + 强制 tool_choice 指向选择工具
    第 2 轮（门已开）：thinking 按用户配置 + 普通 tool_choice

要回答三件事：

1. 关掉思考后强制 tool_choice 会不会被 provider 拒（400）？
2. 第 1 轮关思考/开强制之后，第 2 轮恢复思考还能不能命中前缀缓存？
3. 整条序列下来缓存命中有没有塌陷？

消息前缀全程固定，所以每一轮都能复用同一份缓存；命中比例直接反映
「这一轮的请求参数变化有没有把缓存前缀打断」。

脚本会真实调用线上模型，必须显式传入 --allow-real-llm。
输出只含量化指标、状态码和合成工具参数，不输出 API Key、提示词正文或真实用户内容。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
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

TOOL_SCHEMA_OPENAI = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": _TOOL_DESCRIPTION,
        "parameters": _TOOL_INPUT_SCHEMA,
    },
}

FORCED_TOOL_CHOICE = {"type": "function", "function": {"name": TOOL_NAME}}

# 合成群消息：不含任何真实用户内容。
GROUP_MESSAGE = "群里有人说：这个功能怎么用？"


@dataclass
class Probe:
    """一次请求的量化结果。"""

    label: str = ""
    thinking: str = ""
    tool_choice: str = ""
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
            "thinking": self.thinking,
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
    return str(exc).replace("\n", " ").strip()[:220]


async def _call(
    client: Any,
    model: str,
    prefix: str,
    *,
    thinking_kwargs: dict | None,
    tool_choice: Any,
    thinking_label: str = "",
) -> Probe:
    probe = Probe(
        thinking=thinking_label or ("on" if thinking_kwargs else "off"),
        tool_choice=json.dumps(tool_choice, ensure_ascii=False),
    )
    kwargs: dict[str, Any] = dict(
        model=model,
        messages=[
            {"role": "system", "content": prefix},
            {"role": "user", "content": GROUP_MESSAGE},
        ],
        tools=[TOOL_SCHEMA_OPENAI],
        tool_choice=tool_choice,
        max_tokens=256,
    )
    if thinking_kwargs:
        kwargs.update(thinking_kwargs)
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


async def probe_preset(ai: Any, args) -> list[dict[str, Any]]:
    """跑完整的选择门序列，返回逐行结果。"""
    import httpx

    from agent import providers

    timeout = httpx.Timeout(connect=10.0, read=120.0, write=20.0, pool=5.0)
    adapter = providers.adapter_for(ai)
    model = getattr(ai, "model", "") or ""
    client = providers.build_openai_client(ai, timeout)
    think_on = adapter.build_openai_thinking_kwargs(ai)

    prefix = _stable_prefix(args.prefix_chars)
    rows: list[dict[str, Any]] = []

    def emit(probe: Probe, label: str) -> None:
        probe.label = label
        rows.append(probe.row())

    # 预热：先把前缀缓存打热，后面每一轮的变化才是可比的。
    for index in range(args.warmup):
        probe = await _call(client, model, prefix, thinking_kwargs=think_on, tool_choice="auto")
        emit(probe, f"warmup-on-{index + 1}")

    # 第 1 轮（门还没开）：显式关思考 + 强制 tool_choice。
    # 关思考必须显式发参数：省略思考字段等于沿用 provider 默认（DeepSeek 默认
    # 开着思考，会直接拒收强制 tool_choice）。
    think_off = adapter.build_openai_thinking_kwargs(ai, thinking="disabled")
    emit(await _call(client, model, prefix, thinking_kwargs=think_off or None,
                     tool_choice=FORCED_TOOL_CHOICE, thinking_label="off-explicit"),
          "gate-round-forced")
    emit(await _call(client, model, prefix, thinking_kwargs=think_off or None,
                     tool_choice=FORCED_TOOL_CHOICE, thinking_label="off-explicit"),
          "gate-round-forced-2")
    # 第 2 轮（门已开）：恢复用户配置的思考 + 普通 tool_choice。
    emit(await _call(client, model, prefix, thinking_kwargs=think_on,
                     tool_choice="auto"), "reply-round-thinking-on")
    emit(await _call(client, model, prefix, thinking_kwargs=think_on,
                     tool_choice="auto"), "reply-round-thinking-on-2")
    # 对照：全程 auto + 思考，确认基线命中率。
    emit(await _call(client, model, prefix, thinking_kwargs=think_on,
                     tool_choice="auto"), "baseline-auto")
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
    from agent.llm.llm_select import use_anthropic_for

    settings = get_settings()
    items = list(getattr(getattr(settings, "ai_presets", None), "items", None) or [])
    wanted = {part.strip() for part in args.presets.split(",") if part.strip()}

    for preset in items:
        name = getattr(preset, "name", "") or ""
        pid = str(getattr(preset, "id", "") or "")
        if wanted and name not in wanted and pid not in wanted:
            continue
        if not getattr(preset, "api_key", ""):
            print(json.dumps({"preset": name, "skipped": "no_api_key"}, ensure_ascii=False))
            continue
        if use_anthropic_for(preset):
            print(json.dumps({"preset": name, "skipped": "anthropic_format"}, ensure_ascii=False))
            continue

        print(json.dumps({
            "preset": name,
            "provider": getattr(preset, "provider", ""),
            "model": getattr(preset, "model", ""),
            "api_format": "openai",
            "thinking_configured": getattr(preset, "thinking", ""),
        }, ensure_ascii=False), flush=True)
        try:
            for row in await probe_preset(preset, args):
                print(json.dumps(row, ensure_ascii=False), flush=True)
        except Exception as exc:  # noqa: BLE001 - 单个 preset 失败不影响其余
            print(json.dumps({
                "preset": name,
                "fatal": f"{type(exc).__name__}: {_short_error(exc)}",
            }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
