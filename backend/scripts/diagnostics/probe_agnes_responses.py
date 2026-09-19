#!/usr/bin/env python3
"""用少量合成请求隔离 Agnes Responses 的字段/流式兼容性。

默认拒绝网络请求。运行前由操作者在环境中设置 AGNES_API_KEY，并显式传入
--allow-real-llm。脚本不读取 Gugu 配置、不执行返回的工具、不写数据库或文件，
也不输出模型正文、API 错误正文或凭据。

示例：
    AGNES_API_KEY=... PYTHONPATH=. .venv/bin/python \\
      scripts/diagnostics/probe_agnes_responses.py --allow-real-llm \\
      --model agnes-2.5-flash
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from typing import Any
from urllib.parse import urlparse


_ERROR_MARKERS = (
    "json_parse_error",
    "responseinput",
    "response input",
    "responses endpoint",
    "responses api",
    "does not support responses",
    "unsupported responses",
)
_SAFE_USAGE_FIELDS = (
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "prompt_tokens",
    "completion_tokens",
    "cached_tokens",
    "cache_read_input_tokens",
    "prompt_cache_hit_tokens",
    "cache_creation_input_tokens",
    "prompt_cache_creation_tokens",
    "cache_write_tokens",
)


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        result = dump()
        return result if isinstance(result, dict) else {}
    return {}


def _safe_token(value: Any) -> str | None:
    if value is None or isinstance(value, (dict, list)):
        return None
    text = re.sub(r"[^A-Za-z0-9_.:-]", "", str(value))[:80]
    return text or None


def _usage_summary(value: Any) -> dict[str, Any]:
    usage = _as_dict(value)
    summary = {
        key: usage[key]
        for key in _SAFE_USAGE_FIELDS
        if isinstance(usage.get(key), (int, float))
    }
    for parent in ("input_tokens_details", "prompt_tokens_details"):
        details = _as_dict(usage.get(parent))
        cached = details.get("cached_tokens")
        if isinstance(cached, (int, float)):
            summary[f"{parent}.cached_tokens"] = cached
    return summary


def _error_summary(exc: Exception) -> dict[str, Any]:
    body = _as_dict(getattr(exc, "body", None))
    error = _as_dict(body.get("error")) or body
    searchable_values = [
        getattr(exc, "code", None), getattr(exc, "type", None),
        getattr(exc, "param", None), getattr(exc, "message", None),
        error.get("code"), error.get("type"), error.get("param"), error.get("message"),
    ]
    searchable = " ".join(str(value) for value in searchable_values if value is not None).lower()
    response = getattr(exc, "response", None)
    status = getattr(exc, "status_code", None) or getattr(response, "status_code", None)
    return {
        "status": status if isinstance(status, int) else None,
        "exception": type(exc).__name__,
        "error_code": _safe_token(error.get("code") or getattr(exc, "code", None)),
        "error_type": _safe_token(error.get("type") or getattr(exc, "type", None)),
        "error_param": _safe_token(error.get("param") or getattr(exc, "param", None)),
        "responses_compatibility_marker": any(marker in searchable for marker in _ERROR_MARKERS),
    }


async def _responses_call(client: Any, name: str, request: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"case": name, "accepted": False, "stream_events": []}
    try:
        response = await client.responses.create(**request)
        if request.get("stream"):
            try:
                async for event in response:
                    event_type = str(getattr(event, "type", "") or "")
                    if event_type:
                        result["stream_events"].append(event_type)
                    if event_type == "response.completed":
                        completed = getattr(event, "response", None)
                        result["usage"] = _usage_summary(getattr(completed, "usage", None))
                        result["response_completed"] = True
                    elif event_type in {"response.failed", "error"}:
                        result["provider_error"] = _error_summary(
                            RuntimeError("provider sent an error event")
                        )
                        event_error = _as_dict(getattr(event, "error", None))
                        result["provider_error"].update({
                            "error_code": _safe_token(event_error.get("code")),
                            "error_type": _safe_token(event_error.get("type")),
                        })
                result["accepted"] = bool(result.get("response_completed"))
            finally:
                close = getattr(response, "close", None)
                if callable(close):
                    closed = close()
                    if asyncio.iscoroutine(closed):
                        await closed
        else:
            result["accepted"] = True
            result["usage"] = _usage_summary(getattr(response, "usage", None))
            result["response_completed"] = True
    except Exception as exc:  # 只输出白名单错误元数据，不打印异常正文
        result["provider_error"] = _error_summary(exc)
    return result


async def _chat_completions_call(client: Any, model: str) -> dict[str, Any]:
    result: dict[str, Any] = {"case": "chat_completions_baseline", "accepted": False}
    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "只回复 OK。"}],
            max_tokens=8,
            stream=False,
        )
        result["accepted"] = True
        result["usage"] = _usage_summary(getattr(response, "usage", None))
    except Exception as exc:  # 只输出白名单错误元数据，不打印异常正文
        result["provider_error"] = _error_summary(exc)
    return result


async def run_probe(base_url: str, api_key: str, model: str) -> dict[str, Any]:
    import httpx
    from openai import AsyncOpenAI

    timeout = httpx.Timeout(45.0, connect=10.0, read=45.0, write=10.0, pool=10.0)
    client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=timeout, max_retries=0)
    message = [{"role": "user", "content": "只回复 OK。"}]
    tool = [{
        "type": "function",
        "name": "probe_noop",
        "description": "兼容性探测用；客户端不会执行此工具。",
        "parameters": {
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
            "additionalProperties": False,
        },
    }]
    base_request = {
        "model": model,
        "instructions": "只回复 OK。",
        "input": message,
        "max_output_tokens": 8,
    }
    cases = [
        ("responses_minimal_nonstream", {
            "model": model, "input": "只回复 OK。", "max_output_tokens": 8,
        }),
        ("responses_instructions_structured", dict(base_request)),
        ("responses_stream", {**base_request, "stream": True}),
        ("responses_store_nonstream", {**base_request, "store": True}),
        ("responses_stream_store_tools", {
            **base_request, "stream": True, "store": True, "tools": tool,
        }),
    ]
    results = []
    try:
        for name, request in cases:
            results.append(await _responses_call(client, name, request))
        results.append(await _chat_completions_call(client, model))
    finally:
        await client.close()

    return {
        "provider_host": urlparse(base_url).hostname,
        "model": model,
        "max_output_tokens": 8,
        "calls_made": len(results),
        "results": results,
    }


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-real-llm", action="store_true",
                        help="明确允许发送少量真实模型请求（最多 6 次）")
    parser.add_argument("--base-url", default="https://apihub.agnes-ai.com/v1")
    parser.add_argument("--model", default="agnes-2.5-flash")
    args = parser.parse_args()

    if not args.allow_real_llm:
        parser.error("默认不联网；确认可产生最多 6 次少量 API 用量后再加 --allow-real-llm")
    api_key = os.environ.get("AGNES_API_KEY", "")
    if not api_key:
        parser.error("请先通过环境变量 AGNES_API_KEY 提供 API Key；不要把 Key 写进参数")

    result = await run_probe(args.base_url, api_key, args.model)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
