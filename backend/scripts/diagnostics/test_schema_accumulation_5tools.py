"""5 个工具的 Schema 累积测试：预热 1 轮后连续执行 20 轮。"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from app.core.config import get_settings
from agent.llm.llm_select import pick_model, release, use_anthropic_for
from agent.profiles import DefaultProfile
from agent.tools.base import Tool
from agent.tools import registry

from scripts.diagnostics.test_full_schema_compact_ab import (
    description_anthropic,
    description_openai,
    full_anthropic,
    full_openai,
    run_continuous_sequence,
    schema_metrics,
)


CASES = [
    ("list_folders", "列出个人文件区的文件夹。", {}),
    ("read_file", "读取文件 42 的正文。", {"file_id": 42}),
    ("list_events", "查询 2026-09-01 到 2026-09-07 的日历安排。", {"from": "2026-09-01", "to": "2026-09-07"}),
    ("create_project", "创建项目‘接口重构’，开始日期为 2026-09-01，截止日期为 2026-09-30。", {"name": "接口重构", "start_date": "2026-09-01", "deadline": "2026-09-30"}),
    ("note_create", "记一条笔记：下周检查接口文档。", {"blocks": [{"type": "paragraph", "content": [{"type": "text", "text": "下周检查接口文档"}]}]}),
]


def repeated_cases(rounds: int) -> list[tuple[str, str, dict]]:
    cases = []
    for index in range(rounds):
        for tool, prompt, expected in CASES:
            cases.append((tool, f"第 {index + 1} 轮：{prompt}", expected))
    return cases[:rounds]


async def main_async(args: argparse.Namespace) -> int:
    settings = get_settings()
    model_cfg = pick_model(settings, None)
    if not getattr(model_cfg, "api_key", ""):
        raise RuntimeError("当前默认模型没有配置 API key")
    anthropic = use_anthropic_for(model_cfg)
    original_openai = Tool.to_openai
    original_anthropic = Tool.to_anthropic
    original_dispatch = registry.dispatch
    results: dict[str, list[dict]] = {}
    metrics_by_mode: dict[str, dict] = {}

    async def diagnostic_dispatch(user_id, name, arguments):
        if name == "get_tool_schema" and isinstance(arguments, dict):
            return json.dumps({"tool_schemas": arguments.get("tools", [])}, ensure_ascii=False), None
        return json.dumps({"ok": True, "diagnostic": "not_executed"}, ensure_ascii=False), None

    registry.dispatch = diagnostic_dispatch
    try:
        variants = (
            ("description", description_openai, description_anthropic),
            ("full", full_openai, full_anthropic),
        )
        for label, openai_schema, anthropic_schema in variants:
            Tool.to_openai = openai_schema
            Tool.to_anthropic = anthropic_schema
            tool_names = list(DefaultProfile().tool_names)
            metrics = schema_metrics(
                registry, tool_names, anthropic, getattr(model_cfg, "model", ""),
                description_mode=label == "description", settings=settings,
            )
            sequence = await asyncio.wait_for(
                run_continuous_sequence(
                    settings, model_cfg, anthropic,
                    repeated_cases(args.rounds),
                    description_mode=label == "description",
                ),
                timeout=args.case_timeout * (args.rounds + 1),
            )
            rows = sequence["cases"]
            results[label] = rows
            requests = len(rows) + 1
            metrics_by_mode[label] = {
                **metrics,
                "warmup_requests": 1,
                "measured_rounds": len(rows),
                "schema_tokens_total": metrics["schema_tokens"] * requests,
                "catalog_tokens_total": metrics["catalog_tokens"] * requests,
                "first_round_input": rows[0].get("usage", {}).get("provider_input", 0) if rows else 0,
                "last_round_input": rows[-1].get("usage", {}).get("provider_input", 0) if rows else 0,
                "accuracy": sum(bool(row.get("accurate")) for row in rows),
                "schema_errors": sum(bool(row.get("schema_error")) for row in rows),
                "input_total": sum(int(row.get("usage", {}).get("provider_input", 0) or 0) for row in rows),
                "output_total": sum(int(row.get("usage", {}).get("output", 0) or 0) for row in rows),
                "cache_read_total": sum(int(row.get("usage", {}).get("cache_read", 0) or 0) for row in rows),
            }
            metrics_by_mode[label]["total_tokens"] = metrics_by_mode[label]["input_total"] + metrics_by_mode[label]["output_total"]
            metrics_by_mode[label]["cache_rate"] = round(
                metrics_by_mode[label]["cache_read_total"] / metrics_by_mode[label]["input_total"], 6
            ) if metrics_by_mode[label]["input_total"] else 0
            print(json.dumps({"variant": label, "metrics": metrics_by_mode[label]}, ensure_ascii=False), flush=True)
            for row in rows:
                print(json.dumps({"variant": label, **row}, ensure_ascii=False), flush=True)
    finally:
        Tool.to_openai = original_openai
        Tool.to_anthropic = original_anthropic
        registry.dispatch = original_dispatch
        release(model_cfg)

    output = {"cases": CASES, "summary": metrics_by_mode, "results": results}
    print(json.dumps({"summary": metrics_by_mode}, ensure_ascii=False), flush=True)
    if args.output:
        Path(args.output).write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="5 个工具的 Schema 累积连续会话测试")
    parser.add_argument("--allow-real-llm", action="store_true", help="允许调用真实模型")
    parser.add_argument("--output", required=True, help="脱敏结果 JSON 路径")
    parser.add_argument("--rounds", type=int, default=20, help="预热后执行的连续轮数")
    parser.add_argument("--case-timeout", type=float, default=180, help="每轮超时秒数")
    args = parser.parse_args()
    if not args.allow_real_llm:
        print("拒绝执行：请显式追加 --allow-real-llm")
        return 2
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
