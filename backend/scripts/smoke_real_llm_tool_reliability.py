"""真实 LLM · 工具契约与联网搜索冒烟测试。

这不是 CI 测试：它会使用当前配置的真实模型，并可能访问 SearXNG。

跑法：
    cd backend
    .venv/bin/python scripts/smoke_real_llm_tool_reliability.py --allow-real-llm

默认只启用只读的 ``web_search``，不会创建、修改或删除任何业务数据。
没有显式传 ``--allow-real-llm`` 时直接退出，避免本地测试或 CI 意外产生模型费用。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent.tools  # noqa: F401  注册工具
from agent.context import builder
from agent.core import LLMRunner
from agent.llm.llm_select import pick_model, release, use_anthropic_for
from app.core.config import get_settings


_UID = "00000000-0000-0000-0000-000000000000"
_DEFAULT_QUERY = "Python jsonschema Draft 2020-12 官方文档"


def build_prompt(*args, **kwargs):
    static, dynamic, _ = builder.build_split(*args, **kwargs)
    return "\n\n---\n\n".join(part for part in (static, dynamic) if part)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="调用真实 LLM 验证工具契约与联网搜索链路")
    parser.add_argument(
        "--allow-real-llm",
        action="store_true",
        help="明确允许调用当前配置的真实 LLM（必填）",
    )
    parser.add_argument("--query", default=_DEFAULT_QUERY, help="本次只读搜索关键词")
    parser.add_argument("--timeout", type=float, default=90.0, help="单次调用超时秒数")
    return parser.parse_args()


def _event_payload(raw: str) -> dict[str, Any] | None:
    """解析 LLMRunner 的 SSE 字符串；异常事件直接忽略。"""
    if not raw.startswith("data: "):
        return None
    try:
        value = json.loads(raw[6:])
    except (TypeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


async def _consume_real_call(query: str, expected_max_results: int, timeout: float) -> dict[str, Any]:
    settings = get_settings()
    model_cfg = pick_model(settings, None)
    if not getattr(model_cfg, "api_key", ""):
        raise RuntimeError("当前模型没有配置 API key")

    system_prompt = build_prompt(
        "default",
        "测试用户",
        [],
        [],
        {},
        None,
        skills=[],
        include_projects=False,
        include_calendar=False,
        include_files=False,
        include_memory=False,
    )
    system_prompt += (
        "\n\n## 本次可靠性测试约束\n"
        "你必须调用一次 web_search，且只能调用这个工具。"
        f"工具参数必须是 query={query!r}、max_results={expected_max_results}。"
        "工具返回后只用一句简短中文确认已完成，不要调用其它工具。"
    )

    runner = LLMRunner(["web_search"], settings)
    anthropic = use_anthropic_for(model_cfg)
    if anthropic:
        messages = [{"role": "user", "content": query}]
        generation = runner.run(_UID, system_prompt, messages, True, model_cfg)
    else:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": query},
        ]
        generation = runner.run(_UID, None, messages, False, model_cfg)

    calls: list[dict[str, Any]] = []
    errors: list[str] = []
    try:
        tokens: list[str] = []

        async def consume_events() -> None:
            async for raw in generation:
                event = _event_payload(raw)
                if not event:
                    continue
                event_type = event.get("type")
                if event_type == "tool_call":
                    calls.append({
                        "name": str(event.get("name") or ""),
                        "input": event.get("input"),
                    })
                elif event_type == "token":
                    tokens.append(str(event.get("content") or ""))
                elif event_type == "error":
                    errors.append(str(event.get("detail") or event.get("message") or "未知错误"))

        await asyncio.wait_for(consume_events(), timeout=timeout)
        return {"calls": calls, "errors": errors, "text": "".join(tokens)}
    finally:
        release(model_cfg)

def _validate_result(result: dict[str, Any], query: str, expected_max_results: int) -> list[str]:
    failures: list[str] = []
    calls = result["calls"]
    web_calls = [call for call in calls if call["name"] == "web_search"]
    if not web_calls:
        failures.append("真实 LLM 没有调用 web_search")
    if any(call["name"] != "web_search" for call in calls):
        failures.append("真实 LLM 调用了未授权工具")
    for call in web_calls:
        payload = call["input"]
        if not isinstance(payload, dict):
            failures.append("web_search 参数不是 object")
            continue
        if payload.get("query") != query:
            failures.append("web_search 的 query 未按测试约束生成")
        if payload.get("max_results") != expected_max_results:
            failures.append("web_search 的 max_results 未按测试约束生成")
    if result["errors"]:
        failures.append("LLM 流程返回错误事件")
    return failures


async def _run_contract_matrix() -> list[str]:
    """不联网验证 dispatch 在 handler 之前拒绝常见非法输入。"""
    from agent.tools import registry

    cases = [
        ("缺少 query", {}, "required"),
        ("query 类型错误", {"query": 123}, "type"),
        ("max_results 类型错误", {"query": _DEFAULT_QUERY, "max_results": "3"}, "type"),
        ("max_results 小于下限", {"query": _DEFAULT_QUERY, "max_results": 0}, "minimum"),
        ("max_results 超过上限", {"query": _DEFAULT_QUERY, "max_results": 21}, "maximum"),
    ]
    failures: list[str] = []
    print("【契约矩阵】不联网检查非法输入")
    for label, payload, expected_rule in cases:
        raw, artifact = await registry.dispatch(_UID, "web_search", payload)
        try:
            result = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            result = {}
        issues = result.get("issues") or []
        actual_rules = {item.get("rule") for item in issues if isinstance(item, dict)}
        ok = result.get("error") == "tool_input_invalid" and expected_rule in actual_rules and artifact is None
        print(f"  {'✅' if ok else '❌'} {label}")
        if not ok:
            failures.append(f"契约矩阵失败：{label}")
    return failures


async def main() -> int:
    args = _parse_args()
    if not args.allow_real_llm:
        print("拒绝执行：请显式追加 --allow-real-llm 才会调用真实模型。")
        return 2

    settings = get_settings()
    if not settings.search.searxng_url:
        print("拒绝执行：当前未配置 search.searxng_url，无法完成真实联网搜索链路。")
        return 2

    matrix_failures = await _run_contract_matrix()
    print("【真实 LLM】合法边界场景")
    scenarios = [(args.query, 1), (f"{args.query} 官方规范", 3), (f"{args.query} 最新版本", 20)]
    failures = list(matrix_failures)
    total_calls = 0
    total_text = 0
    for query, expected_max_results in scenarios:
        print(f"  调用 max_results={expected_max_results} …")
        try:
            result = await _consume_real_call(query, expected_max_results, args.timeout)
        except Exception as exc:
            print(f"  ❌ 调用失败：{type(exc).__name__}")
            failures.append(f"真实 LLM 场景失败：max_results={expected_max_results}")
            continue
        scenario_failures = _validate_result(result, query, expected_max_results)
        failures.extend(scenario_failures)
        total_calls += len(result["calls"])
        total_text += len(result["text"])
        if scenario_failures:
            print(f"  ❌ max_results={expected_max_results} 未通过")
        else:
            print(f"  ✅ max_results={expected_max_results} 通过")

    if failures:
        for failure in failures:
            print(f"❌ {failure}")
        print(f"真实工具调用次数：{total_calls}")
        return 1

    print(f"✅ 真实工具调用次数：{total_calls}，最终回复总长度：{total_text}")
    print("✅ 工具契约边界、真实 LLM 参数生成、registry dispatch、SearXNG 搜索和最终回复链路完成")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
