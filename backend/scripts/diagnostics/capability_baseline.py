"""生成 Capability Phase 4 的本地基线报告。

默认只读取注册表，不连接数据库、不读取运行配置。可选传入 LoopScope 导出 JSON，
补充 provider input/cache 的脱敏统计；报告不写入用户消息、Schema 正文或凭据。
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

from agent.capabilities.index import CapabilityIndex
from agent.capabilities.injector import FIXED_ADAPTER_TOOL_NAMES, catalog_block
from agent.tools import registry
from agent.profiles import DefaultProfile


def _p95(values: list[float]) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    return values[min(len(values) - 1, max(0, int(len(values) * 0.95) - 1))]


def _trace_metrics(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"source": str(path.name), "error": "无法读取导出文件"}
    runs = payload if isinstance(payload, list) else payload.get("runs", []) if isinstance(payload, dict) else []
    input_tokens: list[float] = []
    cache_ratios: list[float] = []
    for run in runs:
        for round_item in (run.get("rounds", []) if isinstance(run, dict) else []):
            usage = round_item.get("usage", {}) if isinstance(round_item, dict) else {}
            value = usage.get("input_tokens") or usage.get("prompt_tokens")
            if isinstance(value, (int, float)):
                input_tokens.append(float(value))
            cached = usage.get("cached_tokens") or usage.get("cache_read_input_tokens")
            if isinstance(cached, (int, float)) and isinstance(value, (int, float)) and value:
                cache_ratios.append(float(cached) / float(value))
    return {"source": path.name, "round_count": len(input_tokens),
            "input_tokens_p95": round(_p95(input_tokens), 2),
            "cache_ratio_avg": round(statistics.mean(cache_ratios), 4) if cache_ratios else None}


def build_report(trace_paths: list[Path] | None = None) -> dict[str, object]:
    profile = DefaultProfile()
    names = list(profile.tool_names)
    index = CapabilityIndex.from_registries(tool_names=names)
    snapshot = index.snapshot(authorized_names=names)
    full_openai = len(json.dumps(registry.openai_schemas(names), ensure_ascii=False, separators=(",", ":")))
    fixed_names = [name for name in FIXED_ADAPTER_TOOL_NAMES if registry.get(name) is not None]
    fixed_openai = len(json.dumps(registry.openai_schemas(fixed_names), ensure_ascii=False, separators=(",", ":")))
    timings: list[float] = []
    for _ in range(100):
        started = time.perf_counter()
        catalog_block(snapshot, tool_order=names)
        timings.append((time.perf_counter() - started) * 1000)
    return {
        "tool_count": len(snapshot.tools), "skill_count": len(snapshot.skills),
        "catalog_chars": len(catalog_block(snapshot, tool_order=names)),
        "legacy_openai_schema_chars": full_openai,
        "fixed_adapter_schema_chars": fixed_openai,
        "catalog_build_p95_ms": round(_p95(timings), 3),
        "catalog_build_avg_ms": round(statistics.mean(timings), 3),
        "trace_metrics": [_trace_metrics(path) for path in (trace_paths or [])],
        "note": "provider input/cache 指标仅在传入 LoopScope 导出时统计；本脚本不发起 LLM 请求。",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--trace", action="append", type=Path, default=[])
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = build_report(args.trace)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    print("# Capability Phase 4 基线")
    for key, value in report.items():
        if key != "trace_metrics":
            print(f"- {key}: {value}")
    for item in report["trace_metrics"]:
        print(f"- trace: {json.dumps(item, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
