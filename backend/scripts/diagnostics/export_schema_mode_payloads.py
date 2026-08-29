"""导出简介模式与全量模式的 provider Schema 测试载荷。"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from agent.capabilities.injector import FIXED_ADAPTER_TOOL_NAMES, build_fixed_adapter_context, catalog_block
from agent.profiles import DefaultProfile
from agent.runtime.loopscope_trace.utils import _estimate_tokens
from agent.tools import registry


def _payload(mode: str) -> dict:
    all_names = list(DefaultProfile().tool_names)
    names = list(FIXED_ADAPTER_TOOL_NAMES) if mode == "description" else all_names
    openai_tools = registry.openai_schemas(names)
    anthropic_tools = registry.anthropic_schemas(names)
    catalog = ""
    if mode == "description":
        snapshot = build_fixed_adapter_context(all_names).snapshot
        catalog = catalog_block(snapshot, tool_order=all_names)
    openai_text = json.dumps(openai_tools, ensure_ascii=False, separators=(",", ":"))
    anthropic_text = json.dumps(anthropic_tools, ensure_ascii=False, separators=(",", ":"))
    return {
        "mode": mode,
        "tool_names": all_names,
        "catalog": catalog,
        "openai_tools": openai_tools,
        "anthropic_tools": anthropic_tools,
        "metrics": {
            "catalog_chars": len(catalog),
            "catalog_token_estimate": _estimate_tokens(catalog, "glm-4.5-air") if catalog else 0,
            "openai_schema_chars": len(openai_text),
            "openai_schema_token_estimate": _estimate_tokens(openai_text, "glm-4.5-air"),
            "anthropic_schema_chars": len(anthropic_text),
            "anthropic_schema_token_estimate": _estimate_tokens(anthropic_text, "glm-4.5-air"),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="导出简介模式和全量模式的 Schema 测试载荷")
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for mode in ("description", "full"):
        payload = _payload(mode)
        output = args.output_dir / f"schema-{mode}-20260829.json"
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(output)
        for protocol, key in (("openai", "openai_tools"), ("anthropic", "anthropic_tools")):
            pure_output = args.output_dir / f"schema-{mode}-{protocol}-tools-20260829.json"
            pure_output.write_text(
                json.dumps(payload[key], ensure_ascii=False, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            print(pure_output)
        if mode == "description":
            catalog_output = args.output_dir / "schema-description-catalog-20260829.txt"
            catalog_output.write_text(payload["catalog"], encoding="utf-8")
            print(catalog_output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
