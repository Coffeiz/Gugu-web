"""完整 Schema 与精简完整 Schema 的 20-case A/B 测试。

工具执行被拦截，只比较模型的工具选择、参数和 provider usage，不写入业务数据。
运行需要显式传入 ``--allow-real-llm``。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from agent.llm.llm_select import pick_model, release, use_anthropic_for
from app.core.config import get_settings

_UID = "00000000-0000-0000-0000-000000000000"
CASES = [
    ("create_event", "创建一个 2026-09-03 14:30 的设计评审，标题为接口评审，提前 30 分钟提醒。", {"title": "接口评审", "date": "2026-09-03", "time": "14:30"}),
    ("create_project", "创建项目‘网站重构’，先按你的判断给出精简项目结构。", {"name": "网站重构"}),
    ("search_conversations", "搜索我最近关于文件架构的对话。", {"query": "文件架构"}),
    ("list_files", "列出个人文件区最近的文件，最多 5 个。", {"space": "personal", "limit": 5}),
    ("read_file", "读取文件 42 的正文。", {"file_id": 42}),
    ("copy_file", "把文件 42 复制到文件夹 7。", {"file_id": 42, "target": {"folder_id": 7}}),
    ("send_file", "把文件 42 发给我。", {"file_id": 42}),
    ("save_uploaded_file", "把我刚刚上传且唯一的附件保存到个人文件区。", {"source": "latest"}),
    ("update_todo", "把项目‘网站重构’里的待办‘补充接口文档’标记为完成。", {"project": "网站重构", "todo": "补充接口文档", "action": "complete", "done": True}),
    ("add_event_reminder", "给活动 11 添加提前 60 分钟的网页提醒。", {"event_id": 11, "lead_minutes": 60, "channels": ["web"]}),
    ("web_search", "搜索公开网页‘TypeScript 5.9 release notes’，返回 3 条结果。", {"query": "TypeScript 5.9 release notes", "max_results": 3}),
    ("image_search", "按关键词搜索‘低饱和配色’，找图片候选。", {"query": "低饱和配色"}),
    ("http_get", "读取 https://example.com 的网页内容。", {"url": "https://example.com"}),
    ("create_document", "创建一个名为‘评审记录.md’的 markdown 文档，内容是‘结论：通过’。", {"name": "评审记录.md", "format": "md", "content": "结论：通过"}),
    ("create_folder", "在个人文件区创建文件夹‘归档’。", {"name": "归档"}),
    ("move_items", "把文件 42 移动到文件夹 7。", {"files": ["42"], "target": {"folder_id": 7}}),
    ("list_events", "查询 2026-09-01 到 2026-09-07 的日历安排。", {"from": "2026-09-01", "to": "2026-09-07"}),
    ("search_memory", "搜索与网站重构有关的历史记忆。", {"query": "网站重构"}),
    ("note_create", "记一条笔记：下周检查接口文档。", {"blocks": [{"type": "paragraph", "content": [{"type": "text", "text": "下周检查接口文档"}]}]}),
    ("list_folders", "列出个人文件区的文件夹。", {}),
]


def compact_schema(value: Any, *, root: bool = False) -> Any:
    if isinstance(value, list):
        return [compact_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    omitted = {"description", "example", "examples", "title", "default"}
    return {key: compact_schema(item) for key, item in value.items() if key not in omitted}


def compact_openai(self) -> dict[str, Any]:
    return {"type": "function", "function": {
        "name": self.name, "description": self.description_short,
        "parameters": compact_schema(self.input_schema, root=True),
    }}


def compact_anthropic(self) -> dict[str, Any]:
    return {
        "name": self.name,
        "description": self.description_short,
        "input_schema": compact_schema(self.input_schema, root=True),
    }


def payload(raw: str) -> dict[str, Any] | None:
    if not isinstance(raw, str) or not raw.startswith("data: "):
        return None
    try:
        value = json.loads(raw[6:])
    except (TypeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _text_in_blocks(value: Any) -> str:
    if isinstance(value, dict):
        return " ".join(_text_in_blocks(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(_text_in_blocks(item) for item in value)
    return str(value) if isinstance(value, str) else ""


def matches_expected(tool_name: str, actual: Any, expected: dict[str, Any]) -> bool:
    if not isinstance(actual, dict):
        return False
    if tool_name == "create_document" and actual.get("format") in {"md", "markdown"}:
        expected = {**expected, "format": actual["format"]}
    if tool_name == "note_create":
        expected_text = _text_in_blocks(expected.get("blocks"))
        return bool(expected_text) and expected_text in _text_in_blocks(actual.get("blocks"))
    return all(actual.get(key) == value for key, value in expected.items())


async def run_case(settings, model_cfg, anthropic: bool, tool_name: str, prompt: str, expected: dict[str, Any]) -> dict[str, Any]:
    from agent.core import LLMRunner
    from agent.context import builder
    from agent.profiles import DefaultProfile

    static, dynamic, _ = builder.build_split(
        "default", "Schema 测试用户", [], [], {}, None,
        skills=[], include_projects=False, include_calendar=False,
        include_files=False, include_memory=False,
    )
    system = "\n\n---\n\n".join(part for part in (static, dynamic) if part)
    system += f"\n\n## 测试约束\n只调用一次 `{tool_name}`，不要调用其它工具。完成后停止。工具调用参数必须严格符合用户要求；不要猜测缺失信息。"
    runner = LLMRunner(list(DefaultProfile().tool_names), settings)
    messages = [{"role": "user", "content": prompt}]
    generation = runner.run(_UID, system if anthropic else None, messages if anthropic else [{"role": "system", "content": system}, *messages], anthropic, model_cfg)
    calls: list[dict[str, Any]] = []
    usage_rows: list[dict[str, int]] = []
    errors: list[str] = []
    try:
        async for raw in generation:
            event = payload(raw)
            if not event:
                continue
            if event.get("type") == "tool_call":
                calls.append({"name": event.get("name"), "input": event.get("input")})
            elif event.get("type") == "_usage":
                usage_rows.append({key: int(event.get(key) or 0) for key in ("input", "context_input", "output", "cache_read")})
            elif event.get("type") == "error":
                errors.append(str(event.get("detail") or "error")[:120])
    finally:
        if hasattr(generation, "aclose"):
            await generation.aclose()
    target = next((call for call in calls if call.get("name") == tool_name), None)
    actual = target.get("input") if target else None
    accurate = bool(target) and matches_expected(tool_name, actual, expected) and not errors
    usage = usage_rows[-1] if usage_rows else {"input": 0, "context_input": 0, "output": 0, "cache_read": 0}
    # 当前 devserver 的 Anthropic 口径把 fresh input 与 cache_read 分列；把合计和命中率
    # 一并记录，避免只比较 cache_read 绝对值造成误判。
    # Anthropic 将 fresh input/cache 分列；OpenAI 兼容接口的 input 已包含 cache。
    provider_input = int(usage.get("input", 0) or 0)
    if anthropic:
        provider_input += int(usage.get("cache_read", 0) or 0)
    usage["provider_input"] = provider_input
    usage["cache_ratio"] = round(
        int(usage.get("cache_read", 0) or 0) / provider_input, 6
    ) if provider_input else 0
    return {
        "tool": tool_name,
        "accurate": accurate,
        "called": [call.get("name") for call in calls],
        "calls": calls,
        "usage": usage,
        "error": errors or None,
    }


async def main_async(args: argparse.Namespace) -> int:
    from agent.tools import registry
    from agent.tools.base import Tool

    settings = get_settings()
    model_cfg = pick_model(settings, None)
    if not getattr(model_cfg, "api_key", ""):
        raise RuntimeError("当前默认模型没有配置 API key")
    anthropic = use_anthropic_for(model_cfg)
    original_openai = Tool.to_openai
    original_anthropic = Tool.to_anthropic
    original_dispatch = registry.dispatch

    async def diagnostic_dispatch(user_id, name, arguments):
        """只返回结构化占位结果，禁止 A/B 触发任何真实工具。"""
        return json.dumps({"ok": True, "diagnostic": "not_executed"}, ensure_ascii=False), None

    registry.dispatch = diagnostic_dispatch
    results: dict[str, list[dict[str, Any]]] = {}
    try:
        for label, compact in (("current_full", False), ("prd_compact_full", True)):
            if compact:
                Tool.to_openai = compact_openai
                Tool.to_anthropic = compact_anthropic
            # 先用同一批 case 预热当前方案自己的缓存，再测第二遍；预热结果完全丢弃。
            # 这样不会因 A/B 顺序或前一个方案的缓存前缀不同而偏置 cache_ratio。
            for tool_name, prompt, expected in CASES:
                await run_case(settings, model_cfg, anthropic, tool_name, prompt, expected)
            rows = []
            for index, (tool_name, prompt, expected) in enumerate(CASES, 1):
                started = time.perf_counter()
                try:
                    row = await run_case(settings, model_cfg, anthropic, tool_name, prompt, expected)
                except Exception as exc:
                    row = {"tool": tool_name, "accurate": False, "called": [], "usage": {}, "error": type(exc).__name__}
                row["case"] = index
                row["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
                rows.append(row)
                print(json.dumps({"variant": label, **row}, ensure_ascii=False), flush=True)
            results[label] = rows
    finally:
        Tool.to_openai = original_openai
        Tool.to_anthropic = original_anthropic
        registry.dispatch = original_dispatch
        release(model_cfg)
    summary = {}
    for label, rows in results.items():
        summary[label] = {
            "cases": len(rows),
            "accurate": sum(bool(row.get("accurate")) for row in rows),
            "accuracy_rate": round(sum(bool(row.get("accurate")) for row in rows) / len(rows) * 100, 2) if rows else 0,
            "fresh_input_total": sum(int(row.get("usage", {}).get("input", 0) or 0) for row in rows),
            "context_input_total": sum(int(row.get("usage", {}).get("context_input", 0) or 0) for row in rows),
            "output_total": sum(int(row.get("usage", {}).get("output", 0) or 0) for row in rows),
            "cache_read_total": sum(int(row.get("usage", {}).get("cache_read", 0) or 0) for row in rows),
            "schema_errors": sum(bool(row.get("error")) for row in rows),
        }
        summary[label]["provider_input_total"] = summary[label]["fresh_input_total"] + (
            summary[label]["cache_read_total"] if anthropic else 0
        )
        summary[label]["cache_ratio"] = round(
            summary[label]["cache_read_total"] / summary[label]["provider_input_total"], 6
        ) if summary[label]["provider_input_total"] else 0
    print(json.dumps({"summary": summary}, ensure_ascii=False), flush=True)
    if args.output:
        Path(args.output).write_text(json.dumps({"summary": summary, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="全量 Schema 与精简全量 Schema A/B")
    parser.add_argument("--allow-real-llm", action="store_true", help="允许调用真实模型")
    parser.add_argument("--output", required=True, help="脱敏结果 JSON 路径")
    args = parser.parse_args()
    if not args.allow_real_llm:
        print("拒绝执行：请显式追加 --allow-real-llm")
        return 2
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
