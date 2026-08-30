"""简介模式与全量模式的连续会话测试。

工具执行被拦截，只比较模型的工具选择、参数和 provider usage，不写入业务数据。
每个策略先用 case 1 预热一次，再在同一会话中依次执行 case 1..20；运行需要显式传入
``--allow-real-llm``。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from agent.llm.llm_select import pick_model, release, use_anthropic_for
from agent.context.assembly import PromptMessages
from app.core.config import get_settings

_UID = "00000000-0000-0000-0000-000000000000"
CASES = [
    ("create_event", "创建一个 2026-09-03 14:30 的设计评审，标题为接口评审，提前 30 分钟提醒。", {"title": "接口评审", "date": "2026-09-03", "time": "14:30"}),
    ("create_project", "创建项目‘网站重构’，开始日期为 2026-09-01，截止日期为 2026-09-30。", {"name": "网站重构", "start_date": "2026-09-01", "deadline": "2026-09-30"}),
    ("search_conversations", "搜索我最近关于文件架构的对话。", {"query": "文件架构"}),
    ("list_files", "列出个人文件区最近的文件，最多 5 个。", {"space": "personal", "limit": 5}),
    ("read_file", "读取文件 42 的正文。", {"file_id": 42}),
    ("copy_file", "把文件 42 复制到文件夹 7。", {"file_id": 42, "target": {"folder_id": 7}}),
    ("send_file", "把文件 42 发给我。", {"file_id": 42}),
    ("save_uploaded_file", "把我刚刚上传且唯一的附件保存到个人文件区。", {"source": "latest"}),
    ("update_todo", "把项目‘网站重构’里的待办‘补充接口文档’标记为完成。", {"project": "网站重构", "todo": "补充接口文档", "action": "complete", "done": True}),
    ("add_event_reminder", "给标题为‘活动 11’的活动添加提前 60 分钟的网页提醒。", {"event": "活动 11", "lead_minutes": 60, "channels": ["web"]}),
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


def description_schema(value: Any) -> Any:
    """只保留简介模式路由所需的字段名、类型和必填关系。"""
    if isinstance(value, list):
        return [description_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key in ("type", "required", "items"):
        if key in value:
            result[key] = description_schema(value[key])
    if isinstance(value.get("properties"), dict):
        result["properties"] = {
            name: description_schema(schema)
            for name, schema in value["properties"].items()
        }
    return result


def description_openai(self) -> dict[str, Any]:
    return {"type": "function", "function": {
        "name": self.name, "description": self.description_short,
        "parameters": description_schema(self.input_schema),
    }}


def description_anthropic(self) -> dict[str, Any]:
    return {
        "name": self.name,
        "description": self.description_short,
        "input_schema": description_schema(self.input_schema),
    }


def full_openai(self) -> dict[str, Any]:
    return {"type": "function", "function": {
        "name": self.name, "description": self.description_short,
        "parameters": self.input_schema,
    }}


def full_anthropic(self) -> dict[str, Any]:
    return {
        "name": self.name,
        "description": self.description_short,
        "input_schema": self.input_schema,
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
    """提取 blocks 中的文本，避免把 JSON 字段顺序误当成内容顺序。"""
    if isinstance(value, dict):
        if value.get("type") == "text" and isinstance(value.get("text"), str):
            return value["text"]
        return " ".join(
            _text_in_blocks(item)
            for key, item in value.items()
            if key not in {"type", "name", "format"}
        )
    if isinstance(value, list):
        return " ".join(_text_in_blocks(item) for item in value)
    return value if isinstance(value, str) else ""


def aggregate_usage_rows(
    rows: list[dict[str, int]], anthropic: bool, *, provider_request_count: int | None = None,
) -> dict[str, Any]:
    """按连续 run 聚合 usage，并允许传入真实 provider 请求数。

    core 为一个 run 只发送一个最终 ``_usage`` 事件，不能用 usage 事件数量
    推断 provider 请求数；调用方应统计 ``round_start``。
    """
    requests: list[dict[str, int | float]] = []
    for row in rows:
        provider_input = int(row.get("input", 0) or 0)
        if anthropic:
            provider_input += int(row.get("cache_read", 0) or 0)
        cache_read = int(row.get("cache_read", 0) or 0)
        requests.append({
            "input": int(row.get("input", 0) or 0),
            "context_input": int(row.get("context_input", 0) or 0),
            "output": int(row.get("output", 0) or 0),
            "cache_read": cache_read,
            "provider_input": provider_input,
            "cache_ratio": round(cache_read / provider_input, 6) if provider_input else 0,
        })
    provider_input_total = sum(int(item["provider_input"]) for item in requests)
    cache_read_total = sum(int(item["cache_read"]) for item in requests)
    latest = requests[-1] if requests else {
        "provider_input": 0, "context_input": 0,
    }
    return {
        "input": sum(int(item["input"]) for item in requests),
        "context_input": sum(int(item["context_input"]) for item in requests),
        "output": sum(int(item["output"]) for item in requests),
        "cache_read": cache_read_total,
        "provider_input": provider_input_total,
        "total_tokens": provider_input_total + sum(int(item["output"]) for item in requests),
        "cache_ratio": round(cache_read_total / provider_input_total, 6) if provider_input_total else 0,
        "provider_request_count": (
            int(provider_request_count)
            if provider_request_count is not None else len(requests)
        ),
        "first_provider_input": requests[0]["provider_input"] if requests else 0,
        "last_provider_input": requests[-1]["provider_input"] if requests else 0,
        "context_input_latest": latest["context_input"],
        "provider_input_latest": latest["provider_input"],
        "provider_requests": requests,
    }


def history_metrics(messages: PromptMessages) -> dict[str, Any]:
    """只记录连续会话的结构，不把用户正文或工具参数写入测试结果。"""
    conversation = list(getattr(messages, "conversation", messages))
    roles = Counter(
        str(item.get("role") or "unknown")
        for item in conversation
        if isinstance(item, dict)
    )
    serialized = json.dumps(conversation, ensure_ascii=False, separators=(",", ":"))
    return {
        "message_count": len(conversation),
        "chars": len(serialized),
        "roles": dict(roles),
        "canonical_batch_count": len(getattr(messages, "canonical_batch_digests", ())),
    }


def schema_metrics(registry, tool_names: list[str], anthropic: bool, model: str, *, description_mode: bool, settings) -> dict[str, Any]:
    """记录本轮实际工具声明和简介目录的脱敏 token 估算。"""
    from agent.runtime.loopscope_trace.utils import _estimate_tokens

    from agent.capabilities.injector import FIXED_ADAPTER_TOOL_NAMES

    schema_names = list(FIXED_ADAPTER_TOOL_NAMES) if description_mode else tool_names
    schemas = registry.anthropic_schemas(schema_names) if anthropic else registry.openai_schemas(schema_names)
    schema_text = json.dumps(schemas, ensure_ascii=False, separators=(",", ":"))
    result = {
        "schema_tool_count": len(schemas),
        "schema_chars": len(schema_text),
        "schema_tokens": _estimate_tokens(schema_text, model),
        "catalog_chars": 0,
        "catalog_tokens": 0,
    }
    if description_mode:
        from agent.capabilities.injector import build_fixed_adapter_context, catalog_block

        snapshot = build_fixed_adapter_context(tool_names, search_settings=settings).snapshot
        catalog_text = catalog_block(snapshot, tool_order=tool_names)
        result["catalog_chars"] = len(catalog_text)
        result["catalog_tokens"] = _estimate_tokens(catalog_text, model)
    return result


def matches_expected(tool_name: str, actual: Any, expected: dict[str, Any]) -> bool:
    if not isinstance(actual, dict):
        return False
    if tool_name == "create_document" and actual.get("format") in {"md", "markdown"}:
        expected = {**expected, "format": actual["format"]}
    if tool_name == "note_create":
        expected_text = _text_in_blocks(expected.get("blocks"))
        return bool(expected_text) and expected_text in _text_in_blocks(actual.get("blocks"))
    if tool_name == "add_event_reminder":
        event_ok = actual.get("event_id") == 11 or actual.get("event") == expected.get("event")
        lead_ok = actual.get("lead_minutes") == 60 or actual.get("reminders") == [60]
        return event_ok and lead_ok and actual.get("channels") == expected.get("channels")
    return all(actual.get(key) == value for key, value in expected.items())


def schema_mismatch(tool_name: str, actual: Any, expected: dict[str, Any]) -> dict[str, Any] | None:
    """把失败拆成可读的字段差异，不记录完整用户正文。"""
    if not isinstance(actual, dict):
        return {"kind": "invalid_input", "actual_type": type(actual).__name__}
    if tool_name == "create_document" and actual.get("format") in {"md", "markdown"}:
        expected = {**expected, "format": actual["format"]}
    if tool_name == "add_event_reminder":
        event_ok = actual.get("event_id") == 11 or actual.get("event") == expected.get("event")
        lead_ok = actual.get("lead_minutes") == 60 or actual.get("reminders") == [60]
        if event_ok and lead_ok and actual.get("channels") == expected.get("channels"):
            return None
        return {"kind": "field_mismatch", "missing": [], "mismatched": {"reminder_target_or_lead": {"expected": "event 11 + 60 minutes"}}}
    missing = sorted(key for key in expected if key not in actual)
    mismatched = {
        key: {"expected_type": type(value).__name__, "actual_type": type(actual[key]).__name__}
        for key, value in expected.items()
        if key in actual and actual[key] != value
    }
    if tool_name == "note_create":
        expected_text = _text_in_blocks(expected.get("blocks"))
        if expected_text and expected_text not in _text_in_blocks(actual.get("blocks")):
            mismatched["blocks"] = {"reason": "expected_text_not_found"}
    if not missing and not mismatched:
        return None
    return {"kind": "field_mismatch", "missing": missing, "mismatched": mismatched}


def _test_system(tool_name: str) -> str:
    from agent.context import builder

    static, dynamic, _ = builder.build_split(
        "default", "Schema 测试用户", [], [], {}, None,
        skills=[], include_projects=False, include_calendar=False,
        include_files=False, include_memory=False,
    )
    system = "\n\n---\n\n".join(part for part in (static, dynamic) if part)
    return system + (
        f"\n\n## 测试约束\n每一轮只调用一次 `{tool_name}`，不要调用其它工具。"
        "完成后停止。工具调用参数必须严格符合用户要求；不要猜测缺失信息。"
    )


async def run_continuous_case(
    settings, model_cfg, anthropic: bool, tool_name: str,
    prompt: str, expected: dict[str, Any], turns: int = 2,
) -> dict[str, Any]:
    """在同一个 PromptMessages 中连续调用工具，真实覆盖缓存与工具续轮。"""
    from agent.core import LLMRunner
    from agent.profiles import DefaultProfile

    system = _test_system(tool_name)
    runner = LLMRunner(list(DefaultProfile().tool_names), settings)
    initial = [{"role": "user", "content": prompt}]
    if anthropic:
        messages = PromptMessages(initial)
    else:
        messages = PromptMessages([{"role": "system", "content": system}, *initial])
    rows: list[dict[str, Any]] = []
    for turn in range(1, max(1, turns) + 1):
        if turn > 1:
            messages.append({
                "role": "user",
                "content": f"再次调用 `{tool_name}`，使用相同要求完成这一轮。",
            })
        generation = runner.run(
            _UID, system if anthropic else None, messages,
            anthropic, model_cfg,
        )
        calls: list[dict[str, Any]] = []
        usage_rows: list[dict[str, int]] = []
        provider_usage_rows: list[dict[str, int]] = []
        errors: list[str] = []
        text_parts: list[str] = []
        provider_request_count = 0
        try:
            async for raw in generation:
                event = payload(raw)
                if not event:
                    continue
                if event.get("type") == "tool_call":
                    calls.append({"name": event.get("name"), "input": event.get("input")})
                elif event.get("type") == "round_start":
                    provider_request_count += 1
                elif event.get("type") == "token":
                    text_parts.append(str(event.get("content") or ""))
                elif event.get("type") == "_usage":
                    usage_rows.append({
                        key: int(event.get(key) or 0)
                        for key in ("input", "context_input", "output", "cache_read")
                    })
                elif event.get("type") == "_provider_usage":
                    provider_usage_rows.append({
                        key: int(event.get(key) or 0)
                        for key in ("input", "context_input", "output", "cache_read")
                    })
                elif event.get("type") == "error":
                    errors.append(str(event.get("detail") or "error")[:120])
        finally:
            await generation.aclose()
        target = next((call for call in calls if call.get("name") == tool_name), None)
        actual = target.get("input") if target else None
        mismatch = schema_mismatch(tool_name, actual, expected) if target else {
            "kind": "tool_selection", "expected": tool_name,
            "actual": [call.get("name") for call in calls],
        }
        usage = aggregate_usage_rows(
            provider_usage_rows or usage_rows, anthropic,
            provider_request_count=len(provider_usage_rows) or provider_request_count,
        )
        rows.append({
            "turn": turn,
            "accurate": bool(target) and mismatch is None and not errors,
            "called": [call.get("name") for call in calls],
            "calls": calls,
            "usage": usage,
            "error": errors or None,
            "schema_error": mismatch,
        })
        # 将上一轮最终正文补回同一个会话，下一轮才是真正的 assistant/user 连续历史。
        if text_parts:
            messages.append({"role": "assistant", "content": "".join(text_parts)})
    return {
        "tool": tool_name,
        "turns": rows,
        "accurate": all(row["accurate"] for row in rows),
    }


async def run_continuous_sequence(
    settings, model_cfg, anthropic: bool, cases: list[tuple[str, str, dict[str, Any]]],
    turns: int = 1, *, description_mode: bool = False,
) -> dict[str, Any]:
    """一个策略只创建一个会话：warmup 后依次输入 case1、case2...。"""
    from agent.core import LLMRunner
    from agent.profiles import DefaultProfile

    if not cases:
        return {"warmup": None, "cases": []}
    system = _test_system("当前 case 指定的工具")
    tool_names = list(DefaultProfile().tool_names)
    capability_context = None
    if description_mode:
        from agent.capabilities.injector import build_fixed_adapter_context, catalog_block
        capability_context = build_fixed_adapter_context(tool_names, search_settings=settings)
        system = f"{system}\n\n{catalog_block(capability_context.snapshot, tool_order=tool_names)}"
    runner = LLMRunner(tool_names, settings, capability_context=capability_context)
    if anthropic:
        messages = PromptMessages()
    else:
        messages = PromptMessages([{"role": "system", "content": system}])

    async def run_turn(tool_name: str, prompt: str, expected: dict[str, Any], turn: int) -> dict[str, Any]:
        messages.append({
            "role": "user",
            "content": f"[当前测试目标工具：{tool_name}] {prompt}",
        })
        history_before = history_metrics(messages)
        generation = runner.run(
            _UID, system if anthropic else None, messages,
            anthropic, model_cfg,
        )
        calls: list[dict[str, Any]] = []
        usage_rows: list[dict[str, int]] = []
        provider_usage_rows: list[dict[str, int]] = []
        errors: list[str] = []
        text_parts: list[str] = []
        compactions: list[dict[str, Any]] = []
        provider_request_count = 0
        try:
            async for raw in generation:
                event = payload(raw)
                if not event:
                    continue
                if event.get("type") == "tool_call":
                    calls.append({"name": event.get("name"), "input": event.get("input")})
                elif event.get("type") == "round_start":
                    provider_request_count += 1
                elif event.get("type") == "token":
                    text_parts.append(str(event.get("content") or ""))
                elif event.get("type") == "_usage":
                    usage_rows.append({
                        key: int(event.get(key) or 0)
                        for key in ("input", "context_input", "output", "cache_read")
                    })
                elif event.get("type") == "_provider_usage":
                    provider_usage_rows.append({
                        key: int(event.get(key) or 0)
                        for key in ("input", "context_input", "output", "cache_read")
                    })
                elif event.get("type") == "error":
                    errors.append(str(event.get("detail") or "error")[:120])
                elif event.get("type") == "_context_compaction":
                    compactions.append({
                        "applied": bool(event.get("applied")),
                        "reason": str(event.get("reason") or "")[:80],
                    })
        finally:
            await generation.aclose()
        target = next((call for call in calls if call.get("name") == tool_name), None)
        actual = target.get("input") if target else None
        if (
            description_mode and target is not None
            and isinstance(actual, dict)
            and actual.get("name") == tool_name
            and isinstance(actual.get("arguments"), dict)
        ):
            actual = actual["arguments"]
        if target is None and description_mode:
            adapter_call = next(
                (call for call in calls
                 if call.get("name") == "call_tool"
                 and isinstance(call.get("input"), dict)
                 and call["input"].get("name") == tool_name),
                None,
            )
            if adapter_call is not None:
                target = adapter_call
                actual = adapter_call["input"].get("arguments")
        mismatch = schema_mismatch(tool_name, actual, expected) if target else {
            "kind": "tool_selection", "expected": tool_name,
            "actual": [call.get("name") for call in calls],
        }
        usage = aggregate_usage_rows(
            provider_usage_rows or usage_rows, anthropic,
            provider_request_count=len(provider_usage_rows) or provider_request_count,
        )
        if text_parts:
            messages.append({"role": "assistant", "content": "".join(text_parts)})
        history_after = history_metrics(messages)
        return {
            "turn": turn,
            "tool": tool_name,
            "accurate": bool(target) and mismatch is None and not errors,
            "called": [call.get("name") for call in calls],
            "calls": calls,
            "usage": usage,
            "error": errors or None,
            "schema_error": mismatch,
            "history_before": history_before,
            "history_after": history_after,
            "history_compactions": compactions,
        }

    warmup_tool, warmup_prompt, warmup_expected = cases[0]
    warmup = await asyncio.wait_for(
        run_turn(warmup_tool, warmup_prompt, warmup_expected, 0),
        timeout=180,
    )
    measured: list[dict[str, Any]] = []
    for index, (tool_name, prompt, expected) in enumerate(cases, 1):
        measured.append(await asyncio.wait_for(
            run_turn(tool_name, prompt, expected, index),
            timeout=180,
        ))
    return {"warmup": warmup, "cases": measured}


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
    from agent.profiles import DefaultProfile

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
        if name == "get_tool_schema" and isinstance(arguments, dict):
            return json.dumps({"tool_schemas": arguments.get("tools", [])}, ensure_ascii=False), None
        return json.dumps({"ok": True, "diagnostic": "not_executed"}, ensure_ascii=False), None

    registry.dispatch = diagnostic_dispatch
    results: dict[str, list[dict[str, Any]]] = {}
    mode_metrics: dict[str, dict[str, Any]] = {}
    try:
        variants = (
            ("description", description_openai, description_anthropic),
            ("full", full_openai, full_anthropic),
        )
        if args.mode != "both":
            variants = tuple(item for item in variants if item[0] == args.mode)
        for label, openai_schema, anthropic_schema in variants:
            Tool.to_openai = openai_schema
            Tool.to_anthropic = anthropic_schema
            metrics: dict[str, Any] = {}
            try:
                tool_names = list(DefaultProfile().tool_names)
                metrics = schema_metrics(
                    registry, tool_names, anthropic, getattr(model_cfg, "model", ""),
                    description_mode=label == "description", settings=settings,
                )
                sequence = await asyncio.wait_for(
                    run_continuous_sequence(
                        settings, model_cfg, anthropic, CASES,
                        description_mode=label == "description",
                    ),
                    timeout=args.case_timeout * (len(CASES) + 1),
                )
                rows = sequence["cases"]
                mode_metrics[label] = {
                    **metrics,
                    "requests": len(rows) + 1,
                    "schema_tokens_total": metrics["schema_tokens"] * (len(rows) + 1),
                    "catalog_tokens_total": metrics["catalog_tokens"] * (len(rows) + 1),
                }
                print(json.dumps({"variant": label, "schema_metrics": mode_metrics[label], "warmup": sequence["warmup"]}, ensure_ascii=False), flush=True)
                for row in rows:
                    print(json.dumps({"variant": label, **row}, ensure_ascii=False), flush=True)
            except Exception as exc:
                rows = [{
                    "tool": "sequence", "accurate": False, "turns": [],
                    "error": type(exc).__name__,
                }]
                print(json.dumps({"variant": label, **rows[0]}, ensure_ascii=False), flush=True)
                mode_metrics[label] = metrics
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
            "completed": sum(bool(row.get("usage")) for row in rows),
            "schema_errors": sum(bool(row.get("schema_error")) for row in rows),
        }
        turns = [row for row in rows if row.get("tool") != "sequence"]
        summary[label].update({
            "fresh_input_total": sum(int(turn.get("usage", {}).get("input", 0) or 0) for turn in turns),
            "context_input_total": sum(int(turn.get("usage", {}).get("context_input", 0) or 0) for turn in turns),
            "output_total": sum(int(turn.get("usage", {}).get("output", 0) or 0) for turn in turns),
            "cache_read_total": sum(int(turn.get("usage", {}).get("cache_read", 0) or 0) for turn in turns),
            "continuation_errors": sum(
                1 for turn in turns if turn.get("error") and any("续轮" in str(error) for error in turn["error"])
            ),
        })
        summary[label]["provider_input_total"] = summary[label]["fresh_input_total"] + (
            summary[label]["cache_read_total"] if anthropic else 0
        )
        summary[label]["total_tokens"] = summary[label]["provider_input_total"] + summary[label]["output_total"]
        summary[label]["cache_ratio"] = round(
            summary[label]["cache_read_total"] / summary[label]["provider_input_total"], 6
        ) if summary[label]["provider_input_total"] else 0
        summary[label].update(mode_metrics.get(label, {}))
    print(json.dumps({"summary": summary}, ensure_ascii=False), flush=True)
    if args.output:
        Path(args.output).write_text(json.dumps({"summary": summary, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="简介模式与全量模式测试")
    parser.add_argument("--allow-real-llm", action="store_true", help="允许调用真实模型")
    parser.add_argument("--output", required=True, help="脱敏结果 JSON 路径")
    parser.add_argument("--case-timeout", type=float, default=180, help="连续会话中每个 case 的超时秒数")
    parser.add_argument("--mode", choices=("description", "full", "both"), default="both", help="测试生产注入模式")
    args = parser.parse_args()
    if not args.allow_real_llm:
        print("拒绝执行：请显式追加 --allow-real-llm")
        return 2
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
