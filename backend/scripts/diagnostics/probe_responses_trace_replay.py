#!/usr/bin/env python3
"""从受控 LoopScope trace 回放单次 Responses 请求，不执行任何返回的工具。

默认拒绝读取真实数据和联网。输出目录必须在仓库外；原始请求与事件仅保存在
权限为 0700 的调查目录，控制台只输出结构统计、用量和失败码。不改运行配置。
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
from types import SimpleNamespace
from typing import Any

VARIANTS = (
    "original", "non_stream", "short_tool_output", "short_context",
    "without_last_row", "no_tools", "without_skill_text", "numeric_timeout", "force_call_tool", "raw_sse",
)


def load_trace(args: argparse.Namespace) -> dict:
    if args.trace_export:
        return json.loads(args.trace_export.read_text(encoding="utf-8"))
    uri = args.trace_db.resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT * FROM runs WHERE id=?", (args.run_id,)).fetchone()
        if row is None:
            raise ValueError("未找到指定 run")
        spans = db.execute(
            "SELECT * FROM spans WHERE run_id=? ORDER BY ordinal", (args.run_id,),
        ).fetchall()
    return {"run": dict(row), "spans": [dict(row) for row in spans]}


def round_input(trace: dict, round_number: int | None) -> dict:
    spans = [span for span in trace["spans"] if span["kind"] == "llm"]
    target = next((span for span in spans if span["name"] == f"LLM round {round_number}"), None) if round_number else spans[-1]
    if target is None:
        raise ValueError("指定轮次没有完整 LLM 输入；不能将前一轮误作失败轮次")
    return json.loads(target["input_json"])


def _shorten_tool_output(messages: list[dict], variant: str) -> int:
    if messages[-1].get("role") != "tool":
        raise ValueError("该变体要求最后一项是工具结果")
    result = json.loads(messages[-1]["content"])
    result["stdout"] = (
        "图表已生成。" if variant == "short_tool_output"
        else "\n".join(result["stdout"].splitlines()[:-1]) + "\n"
    )
    messages[-1]["content"] = json.dumps(result, ensure_ascii=False)
    return 1


def _remove_skill_text(messages: list[dict], _variant: str) -> int:
    changed = 0
    for message in messages:
        if message.get("role") != "tool" or not isinstance(message.get("content"), str):
            continue
        try:
            result = json.loads(message["content"])
        except json.JSONDecodeError:
            continue
        if isinstance(result, dict) and result.get("skill_id") and "F1" in str(result.get("content", "")):
            result["content"] = "已加载数据图技能。"
            message["content"] = json.dumps(result, ensure_ascii=False)
            changed += 1
    return changed


def _normalize_timeout(messages: list[dict], _variant: str) -> int:
    latest = next((message for message in reversed(messages)
                   if message.get("role") == "assistant" and message.get("tool_calls")), None)
    if latest is None:
        return 0
    changed = 0
    for call in latest["tool_calls"]:
        function = call["function"]
        payload = json.loads(function["arguments"])
        arguments = payload.get("arguments") or {}
        if isinstance(arguments.get("timeout"), str):
            arguments["timeout"] = int(arguments["timeout"])
            function["arguments"] = json.dumps(payload, ensure_ascii=False)
            changed += 1
    return changed


def variant_messages(source: dict, variant: str) -> tuple[list[dict], int]:
    messages = copy.deepcopy(source["messages"])
    snapshot = source.get("snapshot") or {}
    if snapshot.get("content"):
        # trace 的基础 system 仍可能在 messages 中；snapshot 放在其后以便去重。
        offset = int(bool(messages and messages[0].get("role") == "system"))
        messages.insert(offset, {"role": "system", "content": snapshot["content"]})
    if variant == "short_context":
        return messages[-5:], 1
    transform = {
        "short_tool_output": _shorten_tool_output,
        "without_last_row": _shorten_tool_output,
        "without_skill_text": _remove_skill_text,
        "numeric_timeout": _normalize_timeout,
    }.get(variant)
    if transform is None:
        return messages, 0
    changed = transform(messages, variant)
    if not changed:
        raise ValueError("该变体没有匹配目标，不发送无变化对照")
    return messages, changed


def safe_token(value: Any) -> str | None:
    if value is None or isinstance(value, (dict, list)):
        return None
    return re.sub(r"[^A-Za-z0-9_.:-]", "", str(value))[:128] or None


def terminal_summary(raw: dict) -> dict:
    response = raw.get("response") or raw
    error = response.get("error") or {}
    return {
        "terminal": raw.get("type") or response.get("status"),
        "error_code": safe_token(error.get("code")),
        "response_id": safe_token(response.get("id")),
        "usage": response.get("usage"),
    }


def _record_event(summary: dict, raw: dict) -> None:
    kind = raw.get("type", "")
    summary["events"][kind] = summary["events"].get(kind, 0) + 1
    if kind in {"response.completed", "response.incomplete", "response.failed", "error"}:
        summary.update(terminal_summary(raw))


async def _read_raw_sse(client: Any, request: dict, output: Path, summary: dict) -> None:
    async with client.responses.with_streaming_response.create(**request) as response:
        with (output / "raw-sse.txt").open("w", encoding="utf-8") as handle:
            async for line in response.iter_lines():
                handle.write(line + "\n")
                handle.flush()
                if line.startswith("data:") and line[5:].strip() != "[DONE]":
                    _record_event(summary, json.loads(line[5:].strip()))


async def _read_response(client: Any, request: dict, output: Path, summary: dict) -> None:
    response = await client.responses.create(**request)
    if not request["stream"]:
        raw = response.model_dump()
        (output / "response.json").write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        summary.update(terminal_summary(raw))
        return
    try:
        with (output / "events.jsonl").open("w", encoding="utf-8") as handle:
            async for event in response:
                raw = event.model_dump()
                handle.write(json.dumps(raw, ensure_ascii=False) + "\n")
                handle.flush()
                _record_event(summary, raw)
    finally:
        await response.close()


async def replay(args: argparse.Namespace, source: dict, output: Path) -> dict:
    import httpx
    from app.core.config import get_settings
    from agent import providers
    from agent.providers.openai_responses import (
        _responses_input, _responses_instructions, _responses_prompt_cache_key,
        _responses_tools, _tool_state_digest,
    )
    from agent.tools import registry

    candidates = [item for item in get_settings().ai_presets.items
                  if args.preset in {item.id, item.name, item.model}]
    if len(candidates) != 1:
        raise ValueError("预设必须唯一匹配 id、名称或模型名")
    preset = candidates[0]
    # 协议恢复只在本进程的模型副本中进行，不写回用户配置。
    ai = preset.model_copy(update={
        "api_format": "responses", "max_tokens": args.max_output_tokens,
        "base_url": preset.base_url if preset.api_format == "responses" else "",
    })
    adapter = providers.adapter_for(ai)
    names = args.tool_names.split(",")
    tools = _responses_tools(registry.snapshot().openai_schemas(names))
    serialized = json.dumps(tools, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    schema_digest = hashlib.sha256(serialized.encode()).hexdigest()[:16]
    expected = source.get("assembly", {}).get("cache", {}).get("tool_schema_digest")
    if expected != schema_digest:
        raise ValueError("工具 Schema 与 trace 不同，拒绝把当前声明当作原请求回放")
    messages, changes = variant_messages(source, args.variant)
    instructions = _responses_instructions(messages, source["system_prompt"])
    if args.variant == "short_context":
        instructions = "根据工具结果完成用户请求。"
    request = {
        "model": ai.model, "instructions": instructions,
        "input": _responses_input(messages, media=adapter.responses_input_capabilities(ai)),
        "max_output_tokens": args.max_output_tokens,
        "tools": [] if args.variant == "no_tools" else tools,
        "stream": args.variant != "non_stream",
    }
    if args.variant == "force_call_tool":
        request["tool_choice"] = {"type": "function", "name": "call_tool"}
    request.update(providers.generic_thinking_params(ai, "responses") or adapter.build_responses_reasoning_params(ai))
    request.update(providers.responses_store_params(ai))
    key = _responses_prompt_cache_key(SimpleNamespace(
        supports_prompt_cache_key=adapter.supports_responses_prompt_cache_key(ai),
        model=ai.model, base_instructions=source["system_prompt"],
        instructions=instructions, tool_state_digest=_tool_state_digest(tools),
    ))
    if key:
        request["prompt_cache_key"] = key
    (output / "request.json").write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    summary = {"variant": args.variant, "model": ai.model, "schema_digest": schema_digest,
               "changed_items": changes, "tools_executed": False, "events": {}}
    client = providers.build_openai_client(ai, httpx.Timeout(120, connect=15, read=120))
    started = time.monotonic()
    try:
        reader = _read_raw_sse if args.variant == "raw_sse" else _read_response
        await reader(client, request, output, summary)
    except Exception as exc:
        summary["exception"] = type(exc).__name__
        body = getattr(exc, "body", None)
        (output / "exception.json").write_text(json.dumps(body, ensure_ascii=False, default=str), encoding="utf-8")
    finally:
        await client.close()
        summary["seconds"] = round(time.monotonic() - started, 2)
        (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-real-data", action="store_true")
    parser.add_argument("--allow-real-llm", action="store_true")
    origin = parser.add_mutually_exclusive_group(required=True)
    origin.add_argument("--trace-export", type=Path)
    origin.add_argument("--trace-db", type=Path)
    parser.add_argument("--run-id")
    parser.add_argument("--round", type=int)
    parser.add_argument("--preset", required=True)
    parser.add_argument("--variant", choices=VARIANTS, default="original")
    parser.add_argument("--max-output-tokens", type=int, default=16000)
    parser.add_argument("--tool-names", default="call_tool,get_tool_schema,use_skill,ask_user")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if not args.allow_real_data or not args.allow_real_llm:
        parser.error("必须显式传入 --allow-real-data 和 --allow-real-llm")
    if args.trace_db and not args.run_id:
        parser.error("读取 trace 数据库必须指定 --run-id")
    output = args.output_dir.resolve()
    if output.is_relative_to(Path(__file__).resolve().parents[3]):
        parser.error("原始调查产物必须保存在仓库外")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    summary = asyncio.run(replay(args, round_input(load_trace(args), args.round), output))
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
