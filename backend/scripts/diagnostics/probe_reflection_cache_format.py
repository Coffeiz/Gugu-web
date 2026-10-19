"""在完全相同的历史、JSON 任务和模型下对比追加分支 response_format 的缓存影响。

仅调用模型并解析合成 JSON，不执行工具或写入业务数据；原始请求仅进入 Collector。
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import time
import uuid
from pathlib import Path
from unittest.mock import patch

from probe_inline_compaction_progress import load_case, restore_schema


async def main(args):
    from agent import providers
    from agent.context import provider_runner
    from agent.context.provider_conversation import ProviderConversation
    from agent.llm import modelctx
    from agent.runtime.loopscope_trace import state as tracing
    from agent.tools import registry
    from app.core.config import get_settings

    probe, request, _, _, _ = load_case(args.collector_db, args.run_id)
    if probe["api_format"] != "openai":
        raise RuntimeError("源历史必须来自 Chat Completions")
    settings = get_settings()
    ai = next(cfg for cfg in [settings.ai, *settings.ai_presets.items]
              if cfg.provider == (args.provider or probe["provider"])
              and (args.provider or cfg.model == request["model"]))
    original_adapter = providers.adapter_for(ai)
    old_default = original_adapter.default_base_url_for(ai)
    ai = ai.model_copy(update={"api_format": "openai", "thinking": "disabled"})
    if ai.base_url == old_default:
        ai = ai.model_copy(update={"base_url": original_adapter.default_base_url_for(ai)})
    modelctx.set_model_cfg(ai)
    adapter = providers.adapter_for(ai)
    tools = restore_schema(request["tools"], registry.snapshot().openai_schemas([
        tool["function"]["name"] for tool in request["tools"]
    ]))
    wire = copy.deepcopy(request["messages"][:-1])
    suffix = uuid.uuid4().hex[:12]
    wire[0]["content"] = f"诊断隔离 JSON 缓存 {suffix}\n" + wire[0]["content"]
    history = ProviderConversation(wire, fixed_prefix_size=1)
    task = '内部诊断：只输出有效 JSON 对象 {"ok":true}，不解释，不调用工具。'
    os.environ["LOOPSCOPE_ENABLED"] = "1"
    trace = tracing._ScopeRun(
        id=f"run-json-cache-ab-{suffix}", trace_id=suffix,
        session_key=f"diagnostic:json-cache:{suffix}", external_session_id="",
        source="diagnostic", started_at=time.time(),
        attributes={"scenario": "reflection_json_cache_ab", "provider": ai.provider, "model": ai.model},
    )
    tracing._scope_run.set(trace)

    async def measure(label, json_mode):
        sink, probes = [], []
        output = await provider_runner.complete_messages(
            "", history, task, settings, max_tokens=64, json_mode=json_mode,
            tools=tools, usage_sink=sink, probe_sink=probes,
        )
        valid = (output == {"ok": True}) if json_mode else (provider_runner._parse_json(output) == {"ok": True})
        if not valid:
            raise RuntimeError("合成 JSON 验证失败，此次结果不能用于验收")
        usage = sink[-1]
        fresh, cached = int(usage.get("input") or 0), int(usage.get("cache_read") or 0)
        total = fresh + cached + int(usage.get("cache_write") or 0)
        row = {"input": total, "fresh_input": fresh, "cache_read": cached,
               "output": int(usage.get("output") or 0), "valid_json": valid,
               "cache_ratio": round(cached / total, 6) if total else 0,
               "response_format": probes[-1]["request"].get("response_format")}
        span = trace.span("llm", label, {"provider_request": probes[-1]["request"]})
        span.usage = {key: value for key, value in row.items() if key not in {"valid_json", "response_format"}}
        trace.add_usage(span.usage)
        span.finish(row)
        print(json.dumps({"step": label, **row}, ensure_ascii=False), flush=True)
        return row

    warm = await measure("主对话参数预热", False)
    with patch.object(type(adapter), "build_branch_structured_output",
                      lambda self, cfg, *, has_history: {"response_format": {"type": "json_object"}}):
        before = await measure("A 上游 JSON 模式", True)
    with patch.object(type(adapter), "build_branch_structured_output",
                      lambda self, cfg, *, has_history: {}):
        after = await measure("B 追加 JSON 提示及解析", True)
        repeat = await measure("B 再次复用", True)
    result = {"provider": ai.provider, "model": ai.model, "warm": warm, "A": before,
              "B": after, "B_repeat": repeat, "diagnostic_run_id": trace.id}
    tracing._finish_run(trace, "success")
    await tracing._post_snapshot(trace.snapshot())
    if args.output:
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collector-db", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output")
    parser.add_argument("--provider", choices=["deepseek", "minimax"])
    parser.add_argument("--allow-real-data", action="store_true")
    parser.add_argument("--allow-real-llm", action="store_true")
    args = parser.parse_args()
    if not args.allow_real_data or not args.allow_real_llm:
        parser.error("必须显式提供 --allow-real-data 和 --allow-real-llm")
    asyncio.run(main(args))
