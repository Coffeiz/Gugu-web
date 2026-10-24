"""只读回放 Collector 中的 OpenAI 兼容请求，比较内联压缩前后实际用量。

真实正文仅在内存及受控 Collector 中流转；不执行工具、不修改业务数据库。
默认拒绝读取真实 trace；真实模型调用还需单独提供 --allow-real-llm。
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

import httpx


def load_case(path, run_id):
    with sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True) as db:
        rows = db.execute(
            "SELECT name, input_json, output_json FROM spans WHERE run_id=? ORDER BY ordinal",
            (run_id,),
        ).fetchall()
    probe = next(json.loads(i) for n, i, _ in rows if n == "Compaction provider cache probe")
    request = probe["provider_request"]
    frames = [(json.loads(i), json.loads(o)) for n, i, o in rows if n.startswith("LLM round ")]
    initial = next(json.loads(i)["messages"] for n, i, _ in rows if n == "Conversation messages sent to loop")
    target = next(index for index, (frame, _) in enumerate(frames)
                  if frame["messages"] == request["messages"][1:-1])
    return probe, request, frames, initial[-1], target


def canonical(message):
    from agent.context.history import canonicalize_tool_messages

    return canonicalize_tool_messages([message]) or [copy.deepcopy(message)]


def comparable(messages):
    """只允许 canonical 渲染将单个纯文本 block 与字符串相互转换。"""
    result = copy.deepcopy(messages)
    for message in result:
        content = message.get("content")
        if isinstance(content, list) and len(content) == 1 and content[0].get("type") == "text":
            message["content"] = content[0]["text"]
    return result


def tool_tail(messages):
    start = max(index for index, message in enumerate(messages)
                if message.get("role") == "assistant" and message.get("tool_calls"))
    return copy.deepcopy(messages[start:])


def usage_values(raw):
    total = int(raw.get("prompt_tokens") or 0)
    cached = int(raw.get("prompt_cache_hit_tokens") or (raw.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
    return {"input": total, "cache_read": cached, "fresh_input": total - cached,
            "output": int(raw.get("completion_tokens") or 0),
            "cache_ratio": round(cached / total, 6) if total else 0}


def restore_schema(captured, live):
    """仅补齐 Collector 序列化深度上限截掉的 Schema，其他字段必须一致。"""
    if captured == "<max-depth>":
        return copy.deepcopy(live)
    if isinstance(captured, dict) and isinstance(live, dict) and captured.keys() == live.keys():
        return {key: restore_schema(value, live[key]) for key, value in captured.items()}
    if isinstance(captured, list) and isinstance(live, list) and len(captured) == len(live):
        return [restore_schema(value, replacement) for value, replacement in zip(captured, live)]
    if captured != live:
        raise RuntimeError("当前工具 Schema 与历史记录不同，不能用于同输入回放")
    return copy.deepcopy(captured)


async def main(args):
    from agent import providers
    from agent.context import compaction
    from agent.context.assembly import MessageArea
    from agent.loop.context_runtime import ContextRuntime
    from agent.loop.models import RunState
    from agent.providers.message_utils import render_openai_request_history
    from app.core.config import get_settings

    probe, request, frames, user, target = load_case(args.collector_db, args.run_id)
    if probe["api_format"] != "openai":
        raise RuntimeError("此回放器仅支持已捕获的 OpenAI Chat Completions 请求")
    from agent.tools import registry

    schemas = registry.snapshot().openai_schemas([tool["function"]["name"] for tool in request.get("tools", [])])
    request["tools"] = restore_schema(request.get("tools", []), schemas)
    settings = get_settings()
    ai = next((cfg for cfg in [settings.ai, *settings.ai_presets.items]
               if cfg.provider == probe["provider"] and cfg.model == request["model"]), None)
    if ai is None:
        raise RuntimeError("当前配置没有与历史请求同 Provider、同模型的凭据，停止回放")
    configured_context_tokens = ai.context_tokens
    ai = ai.model_copy(update={
        "thinking": "disabled", "api_format": "openai", "max_tokens": request["max_tokens"],
        "context_tokens": args.context_tokens or configured_context_tokens,
    })
    from agent.llm import modelctx

    modelctx.set_model_cfg(ai)
    adapter = providers.adapter_for(ai)
    base = copy.deepcopy(request["messages"][:-1])
    anchor = max(index for index, message in enumerate(base) if message == user)
    starts = [index for index in range(anchor + 1, len(base))
              if base[index].get("role") == "assistant" and base[index].get("tool_calls")]
    if not starts or len(frames) < target + 4:
        raise RuntimeError("缺少至少三个后续工具轮，无法进行同输入回放")

    result = {"provider": ai.provider, "model": ai.model, "context_tokens": ai.context_tokens,
              "configured_context_tokens": configured_context_tokens,
              "source_round": target + 1, "mode": "real_ab" if args.allow_real_llm else "structure_only"}
    suffix = uuid.uuid4().hex[:12]
    trace = None
    if args.allow_real_llm:
        from agent.runtime.loopscope_trace import state as trace_state

        os.environ["LOOPSCOPE_ENABLED"] = "1"
        trace = trace_state._ScopeRun(
            id=f"run-compaction-ab-{suffix}", trace_id=suffix,
            session_key=f"diagnostic:compaction:{suffix}", external_session_id="",
            source="diagnostic", started_at=time.time(),
            attributes={"scenario": "inline_compaction_ab", "provider": ai.provider, "model": ai.model},
        )
        trace_state._scope_run.set(trace)

    client = providers.build_openai_client(ai, httpx.Timeout(120.0, connect=10.0)) if args.allow_real_llm else None

    async def measure(messages, label, *, json_mode=False):
        wire = copy.deepcopy(messages)
        wire.append({"role": "user", "content": (
            "诊断回放，仅回复 JSON 对象 {}，不调用工具。" if json_mode
            else "诊断回放，仅回复 OK，不调用工具。"
        )})
        started = time.monotonic()
        response = await client.chat.completions.create(
            model=ai.model, messages=wire, tools=request.get("tools") or None,
            tool_choice="auto", max_tokens=16,
            **({"response_format": {"type": "json_object"}} if json_mode else {}),
            **adapter.build_openai_thinking_kwargs(ai),
        )
        usage = usage_values(response.usage.model_dump())
        usage["elapsed_seconds"] = round(time.monotonic() - started, 3)
        span = trace.span("llm", label, {"messages": wire}, scenario="inline_compaction_ab")
        span.usage = {key: value for key, value in usage.items() if key != "elapsed_seconds"}
        trace.add_usage(span.usage)
        span.finish({"usage": usage})
        print(json.dumps({"step": label, **usage}, ensure_ascii=False), flush=True)
        return usage

    def mark(messages, variant):
        marked = copy.deepcopy(messages)
        marked[0]["content"] = f"诊断隔离 {suffix} {variant}\n" + marked[0]["content"]
        return marked

    try:
        if client is not None:
            a_warm = await measure(mark(base, "A"), "A 预热")
            a_rows = []
            for offset in range(1, 4):
                wire = [base[0], *frames[target + offset][0]["messages"]]
                a_rows.append(await measure(mark(wire, "A"), f"A 轮次 {offset}"))
            result["A"] = {"warm": a_warm, "rounds": a_rows}

        b_base = mark(base, "B") if client is not None else base
        values = [b_base[0], *[item for message in b_base[1:] for item in canonical(message)]]
        area = MessageArea.from_canonical_messages(values, fixed_prefix_size=1, render_options={"api_format": "openai"})
        projection = render_openai_request_history(area.provider_projection(), adapter)
        if comparable(projection.to_messages()) != comparable(b_base):
            raise RuntimeError("重建后的请求与捕获请求不一致，拒绝使用失真的输入进行 A/B")
        # 分支直接使用捕获的 wire，避免纯文本包装差异污染缓存测量。
        area.last_provider_projection = projection.with_messages(b_base)
        state = RunState(run_id=f"diagnostic-{suffix}", session_id=None)
        state.round_number = len(starts) + 1
        state.round_start_indices = [(number, index) for number, index in enumerate(starts, 1)]
        state.round_start_indices.append((state.round_number, len(base)))
        state.run_context_usage = int(frames[target][1].get("usage", {}).get("input") or 0)
        runtime = ContextRuntime(area, state, ai, "", None, anchor, branch_tools=request.get("tools"))
        if client is None:
            async def synthetic_summary(*args, **kwargs):
                return "合成摘要：保留任务目标和较早执行结论，不包含真实正文。"
            compaction._generate_append_summary = synthetic_summary
        else:
            result["B"] = {"warm": await measure(b_base, "B 预热"), "rounds": []}
        if not await runtime.compact_now():
            raise RuntimeError("新策略未产生压缩结果")
        b_initial = runtime.messages.provider_projection().to_messages()
        if user not in b_initial:
            raise RuntimeError("压缩未完整保留用户最后原文")
        result["user_preserved"] = True
        result["before_chars"] = len(json.dumps(base, ensure_ascii=False))
        result["after_chars"] = len(json.dumps(b_initial, ensure_ascii=False))
        result["B_additional_compactions"] = 0
        for offset in range(1, 4):
            for message in tool_tail(frames[target + offset][0]["messages"]):
                for item in canonical(message):
                    runtime.messages.append(item)
            state.round_number += 1
            state.round_start_indices.append((state.round_number, len(runtime.messages.provider_projection())))
            wire = render_openai_request_history(runtime.messages.provider_projection(), adapter)
            if client is not None:
                row = await measure(wire.to_messages(), f"B 轮次 {offset}")
                result["B"]["rounds"].append(row)
                state.run_context_usage = row["input"]
                runtime.messages.last_provider_projection = wire
                if await runtime.compact_after_usage_threshold():
                    result["B_additional_compactions"] += 1
        if client is not None and args.probe_reflection_format:
            result["format_probe"] = {
                "text": await measure(b_base, "同前缀文本分支"),
                "json": await measure(b_base, "同前缀 JSON 分支", json_mode=True),
            }
        if trace is not None:
            trace_state._finish_run(trace, "success")
            await trace_state._post_snapshot(trace.snapshot())
            result["diagnostic_run_id"] = trace.id
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
        if args.output:
            Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    finally:
        if client is not None:
            await client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collector-db", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output")
    parser.add_argument("--context-tokens", type=int)
    parser.add_argument("--probe-reflection-format", action="store_true")
    parser.add_argument("--allow-real-data", action="store_true")
    parser.add_argument("--allow-real-llm", action="store_true")
    args = parser.parse_args()
    if not args.allow_real_data:
        parser.error("读取真实 trace 必须显式提供 --allow-real-data")
    asyncio.run(main(args))
