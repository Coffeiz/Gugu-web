#!/usr/bin/env python3
"""对真实 session 的 MiniMax M3 / GLM / Bailian / DeepSeek 做 20-run cache 矩阵测试。

每个 provider 独立使用同一个真实 session 的 snapshot 与 history，连续发送 20 个
run；每个 run 只有 1 个 provider round。固定 Adapter schema 会随请求发送，但工具
不真正执行：模型返回的 tool call 只追加脱敏诊断 tool_result，避免修改真实业务数据。

输出保存完整 run/round 统计，但不保存提示词、模型正文、工具参数、附件名或密钥。
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from test_real_session_20_run_cache import (  # noqa: E402
    SCENARIOS,
    canonical,
    digest,
    first_diff,
    load_real_context,
    message_shape,
    serialize_content_block,
)


@dataclass(frozen=True)
class Target:
    label: str
    provider: str
    ai: Any
    anthropic: bool


def nested_value(obj: Any, *path: str) -> int:
    current = obj
    for key in path:
        if current is None:
            return 0
        if isinstance(current, dict):
            current = current.get(key)
        else:
            current = getattr(current, key, None)
    try:
        return int(current or 0)
    except (TypeError, ValueError):
        return 0


def usage_values(usage: Any, *, anthropic: bool) -> dict[str, int | float]:
    """统一 MiniMax/Anthropic 与 OpenAI-compatible usage 口径。"""
    if anthropic:
        fresh = nested_value(usage, "input_tokens")
        cache_read = max(
            nested_value(usage, "cache_read_input_tokens"),
            nested_value(usage, "prompt_cache_hit_tokens"),
        )
        cache_write = max(
            nested_value(usage, "cache_creation_input_tokens"),
            nested_value(usage, "prompt_cache_creation_tokens"),
        )
        output = nested_value(usage, "output_tokens")
        total_input = fresh + cache_read
    else:
        total_input = max(
            nested_value(usage, "prompt_tokens"),
            nested_value(usage, "input_tokens"),
        )
        cache_read = max(
            nested_value(usage, "prompt_tokens_details", "cached_tokens"),
            nested_value(usage, "prompt_cache_hit_tokens"),
            nested_value(usage, "cache_read_input_tokens"),
        )
        cache_write = max(
            nested_value(usage, "prompt_cache_creation_tokens"),
            nested_value(usage, "cache_creation_input_tokens"),
        )
        output = max(
            nested_value(usage, "completion_tokens"),
            nested_value(usage, "output_tokens"),
        )
        cache_read = min(cache_read, total_input)
        fresh = max(total_input - cache_read, 0)

    return {
        "input_tokens": total_input,
        "fresh_input_tokens": fresh,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "output_tokens": output,
        "cache_ratio": round(cache_read / total_input * 100, 2) if total_input else 0,
    }


def select_targets(settings, requested: set[str]) -> list[Target]:
    presets = list(getattr(getattr(settings, "ai_presets", None), "items", None) or [])
    selected: list[Target] = []
    seen: set[str] = set()
    for index, item in enumerate(presets):
        provider = str(getattr(item, "provider", "") or "").lower()
        model = str(getattr(item, "model", "") or "")
        if provider == "minimax" and "m3" in model.lower():
            label = "minimax-m3"
            anthropic = True
        elif provider == "glm":
            label = "glm"
            anthropic = False
        elif provider in {"qwen", "bailian", "dashscope"}:
            label = "bailian"
            anthropic = False
        elif provider == "deepseek":
            label = "deepseek"
            anthropic = False
        else:
            continue
        if label in seen or (requested and label not in requested):
            continue
        seen.add(label)
        selected.append(Target(label, provider, item, anthropic))
    missing = requested - {target.label for target in selected}
    if missing:
        raise RuntimeError(f"devserver 真实预设缺少：{', '.join(sorted(missing))}")
    if not selected:
        raise RuntimeError("没有找到请求的 MiniMax M3 / GLM / Bailian / DeepSeek 真实预设")
    return selected


def anthropic_tool_calls(response: Any) -> tuple[list[dict], list[dict]]:
    calls: list[dict] = []
    blocks: list[dict] = []
    for block in getattr(response, "content", []) or []:
        item = serialize_content_block(block)
        blocks.append(item)
        if item.get("type") == "tool_use":
            calls.append({
                "id": str(item.get("id") or "diagnostic-call"),
                "name": str(item.get("name") or "unknown"),
            })
    return calls, blocks


def openai_tool_calls(response: Any) -> tuple[list[dict], dict]:
    message = response.choices[0].message
    raw_calls = list(getattr(message, "tool_calls", None) or [])
    calls = [
        {
            "id": str(getattr(call, "id", None) or "diagnostic-call"),
            "name": str(getattr(getattr(call, "function", None), "name", None) or "unknown"),
        }
        for call in raw_calls
    ]
    assistant = {
        "role": "assistant",
        "content": getattr(message, "content", None) or "",
    }
    if raw_calls:
        assistant["tool_calls"] = [
            call.model_dump() if hasattr(call, "model_dump") else dict(call)
            for call in raw_calls
        ]
    return calls, assistant


def append_anthropic_history(conversation: list[dict], response: Any, calls: list[dict], blocks: list[dict]) -> None:
    conversation.append({"role": "assistant", "content": blocks or "（无文本输出）"})
    if calls:
        conversation.append({
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": call["id"],
                    "content": json.dumps({"ok": True, "diagnostic": "not_executed"}, ensure_ascii=False),
                }
                for call in calls
            ],
        })


def append_openai_history(conversation: list[dict], calls: list[dict], assistant: dict) -> None:
    conversation.append(assistant)
    if calls:
        conversation.extend({
            "role": "tool",
            "tool_call_id": call["id"],
            "content": json.dumps({"ok": True, "diagnostic": "not_executed"}, ensure_ascii=False),
        } for call in calls)


async def call_anthropic(target: Target, system: str, messages: list[dict], tools: list[dict]) -> Any:
    import httpx
    from agent import providers
    from agent.llm.llm_select import supports_anthropic_active_cache

    client = providers.build_anthropic_client(
        target.ai,
        httpx.Timeout(180.0, connect=15.0, read=180.0, write=15.0, pool=15.0),
    )
    try:
        system_payload: str | list[dict] = system
        if supports_anthropic_active_cache(target.ai):
            system_payload = [{
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"},
            }]
        return await client.messages.create(
            model=getattr(target.ai, "model", ""),
            max_tokens=min(int(getattr(target.ai, "max_tokens", 512) or 512), 512),
            temperature=float(getattr(target.ai, "temperature", 0.2) or 0.2),
            system=system_payload,
            messages=messages,
            tools=tools,
        )
    finally:
        await client.close()


async def call_openai(target: Target, system: str, messages: list[dict], tools: list[dict]) -> Any:
    import httpx
    from agent import providers
    from openai import AsyncOpenAI

    adapter = providers.adapter_for(target.ai)
    request_kwargs = {}
    request_kwargs.update(adapter.build_openai_thinking_kwargs(target.ai))
    request_kwargs.update(adapter.build_tool_params(target.ai, tools))
    request_kwargs.update(adapter.build_openai_cache_kwargs(target.ai))
    system_message: dict[str, Any] = {"role": "system", "content": system}
    if adapter.supports_explicit_cache(getattr(target.ai, "model", "") or ""):
        system_message["content"] = [{
            "type": "text", "text": system,
            "cache_control": {"type": "ephemeral"},
        }]

    timeout = httpx.Timeout(60.0, connect=15.0, read=60.0, write=15.0, pool=15.0)
    if os.environ.get("GUGU_DIAG_OPENAI_ONLY"):
        client = AsyncOpenAI(
            api_key=getattr(target.ai, "api_key", "") or "dummy",
            base_url=adapter.resolve_base_url(target.ai),
            timeout=timeout,
            default_headers=adapter.auth_headers(target.ai),
        )
    else:
        client = providers.build_openai_client(target.ai, timeout)
    try:
        return await client.chat.completions.create(
            model=getattr(target.ai, "model", ""),
            max_tokens=min(int(getattr(target.ai, "max_tokens", 512) or 512), 512),
            temperature=float(getattr(target.ai, "temperature", 0.2) or 0.2),
            messages=[system_message, *messages],
            **request_kwargs,
        )
    finally:
        await client.close()


async def run_target(target: Target, session, snapshot: dict, history: list, request, args) -> dict:
    from agent.context import assembly, session_snapshot
    from agent.context.history import build_history_parts
    from agent.llm.llm_select import use_anthropic_for
    from agent import providers
    from agent.context.canonical_tool_history import render_events_for_provider
    from agent.loop_drivers import _with_history_cache, _with_single_history_cache
    from agent.tools import registry

    history_parts = build_history_parts(
        history,
        request,
        use_anthropic=use_anthropic_for(target.ai),
        user_tz=None,
    )
    snapshot_context = str(snapshot.get("snapshot_context") or "")
    conversation = ([session_snapshot.reminder_message(snapshot_context)] if snapshot_context else []) + history_parts
    tools = (
        registry.anthropic_schemas(["call_tool", "use_skill", "ask_user"])
        if target.anthropic else registry.openai_schemas(["call_tool", "use_skill", "ask_user"])
    )
    previous_outbound: list[dict] | None = None
    rows: list[dict] = []
    system = str(snapshot["system_prompt"])

    header = {
        "target": target.label,
        "provider": target.provider,
        "model": getattr(target.ai, "model", ""),
        "session_id": session.id,
        "runs_requested": args.runs,
        "tool_schema_names": [item.get("name") or item.get("function", {}).get("name") for item in tools],
        "initial_history": message_shape(conversation),
        "mode": "one provider call per run; tool dispatch disabled",
    }
    print(json.dumps(header, ensure_ascii=False), flush=True)

    for run_index in range(1, args.runs + 1):
        label, prompt = SCENARIOS[run_index - 1]
        current_user = {"role": "user", "content": prompt}
        prompt_messages = assembly.PromptMessages(
            conversation,
            fixed_prefix_size=1 if snapshot_context else 0,
        )
        turn_batch, _ = assembly.assemble_turn(
            stance=f"诊断 {target.label} run {run_index} 的姿态",
            current_user=current_user,
        )
        prompt_messages.append_batch(turn_batch)
        outbound = render_events_for_provider(prompt_messages)
        adapter = providers.adapter_for(target.ai)
        if ((target.anthropic or adapter.supports_explicit_cache(getattr(target.ai, "model", "") or ""))
                and not os.environ.get("GUGU_DIAG_SKIP_OPENAI_HISTORY_CACHE")
                and not os.environ.get("GUGU_DIAG_OPENAI_ONLY")):
            if adapter.uses_single_history_cache_anchor(getattr(target.ai, "model", "") or ""):
                outbound = _with_single_history_cache(outbound)
            else:
                outbound = _with_history_cache(outbound)
        started = time.perf_counter()
        try:
            response = (
                await call_anthropic(target, system, outbound, tools)
                if target.anthropic
                else await call_openai(target, system, outbound, tools)
            )
            if target.anthropic:
                calls, blocks = anthropic_tool_calls(response)
                assistant = None
            else:
                calls, assistant = openai_tool_calls(response)
                blocks = None
            usage = usage_values(response.usage, anthropic=target.anthropic)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            round_result = {
                "round": 1,
                "ok": True,
                "elapsed_ms": elapsed_ms,
                "request": message_shape(outbound),
                "first_diff_from_previous_run": first_diff(previous_outbound, outbound),
                "tool_calls": [call["name"] for call in calls],
                "tool_call_count": len(calls),
                "usage": usage,
            }
            row = {
                "run": run_index,
                "scenario": label,
                "rounds": [round_result],
            }
            rows.append(row)
            print(json.dumps({"target": target.label, **row}, ensure_ascii=False), flush=True)
            previous_outbound = outbound
            conversation.append(current_user)
            if target.anthropic:
                append_anthropic_history(conversation, response, calls, blocks or [])
            else:
                append_openai_history(conversation, calls, assistant or {"role": "assistant", "content": ""})
        except Exception as exc:
            try:
                from app.core.redaction import redact
                safe_error = redact(str(exc))[:300]
            except Exception:
                safe_error = type(exc).__name__
            round_result = {
                "round": 1,
                "ok": False,
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
                "request": message_shape(outbound),
                "first_diff_from_previous_run": first_diff(previous_outbound, outbound),
                "error_type": type(exc).__name__,
                "error_digest": digest(str(exc)[:1000]),
                "error_summary": safe_error,
            }
            row = {"run": run_index, "scenario": label, "rounds": [round_result]}
            rows.append(row)
            print(json.dumps({"target": target.label, **row}, ensure_ascii=False), flush=True)
            # provider 单个 run 的失败不能阻断剩余诊断；下一 run 从上一个
            # 成功的 conversation baseline 继续，报告会明确保留失败 round。
            if args.continue_on_error:
                if args.pause:
                    await asyncio.sleep(args.pause)
                continue
            break
        if args.pause:
            await asyncio.sleep(args.pause)

    successful = [row for row in rows if row["rounds"][0].get("ok")]
    round_results = [row["rounds"][0] for row in successful]
    ratios = [float(item["usage"]["cache_ratio"]) for item in round_results]
    summary = {
        "runs_attempted": len(rows),
        "runs_completed": len(successful),
        "runs_requested": args.runs,
        "complete": len(rows) == args.runs,
        "failed_runs": len(rows) - len(successful),
        "cache_ratio_avg": round(sum(ratios) / len(ratios), 2) if ratios else 0,
        "cache_ratio_min": min(ratios) if ratios else 0,
        "cache_ratio_max": max(ratios) if ratios else 0,
        "input_tokens_total": sum(int(item["usage"]["input_tokens"]) for item in round_results),
        "fresh_input_tokens_total": sum(int(item["usage"]["fresh_input_tokens"]) for item in round_results),
        "cache_read_tokens_total": sum(int(item["usage"]["cache_read_tokens"]) for item in round_results),
        "output_tokens_total": sum(int(item["usage"]["output_tokens"]) for item in round_results),
        "elapsed_ms_total": round(sum(float(item["elapsed_ms"]) for item in round_results), 1),
        "tool_call_runs": sum(1 for item in round_results if item.get("tool_call_count")),
        "observed_tools": sorted({name for item in round_results for name in item.get("tool_calls", [])}),
    }
    print(json.dumps({"target": target.label, "summary": summary}, ensure_ascii=False), flush=True)
    return {"target": target.label, "header": header, "summary": summary, "runs": rows}


async def main_async(args) -> int:
    from app.core.config import get_settings

    settings = get_settings()
    requested = set(args.providers.split(",")) if args.providers else {"minimax-m3", "glm", "bailian", "deepseek"}
    targets = select_targets(settings, requested)
    session, snapshot, history, request = await load_real_context(args.session_id, args.max_messages)
    print(json.dumps({
        "matrix": "real-session-cache",
        "session_id": session.id,
        "targets": [target.label for target in targets],
        "runs_per_target": args.runs,
    }, ensure_ascii=False), flush=True)
    reports = []
    for target in targets:
        reports.append(await run_target(target, session, snapshot, history, request, args))
    matrix_summary = {
        target["target"]: target["summary"]
        for target in reports
    }
    print(json.dumps({"matrix_summary": matrix_summary}, ensure_ascii=False), flush=True)
    if args.output:
        Path(args.output).write_text(json.dumps({
            "session_id": session.id,
            "targets": [target.label for target in targets],
            "reports": reports,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if all(item["summary"]["complete"] for item in reports) else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="真实 session 多模型 20-run cache 矩阵")
    parser.add_argument("--session-id", type=int)
    parser.add_argument("--providers", help="逗号分隔：minimax-m3,glm,bailian,deepseek")
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--max-messages", type=int, default=200)
    parser.add_argument("--pause", type=float, default=1.0)
    parser.add_argument("--continue-on-error", action="store_true", default=True,
                        help="单个 run 失败后继续后续 run（默认开启）")
    parser.add_argument("--output", required=True, help="脱敏 JSON 报告路径")
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("run 数量必须大于 0")
    raise SystemExit(asyncio.run(main_async(args)))


if __name__ == "__main__":
    main()
