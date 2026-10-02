#!/usr/bin/env python3
"""用真实 Responses 模型对比完整历史的 reasoning 回放开关。

测试只调用模型接口，不连接业务数据库、不读取真实会话、不执行工具。天气工具
仅作为模型可调用的探针，第一次工具回执使用固定合成数据。脚本默认拒绝联网，
必须显式传入 ``--allow-real-llm``。输出不包含提示词正文、模型回复、工具参数原文、
API Key、response ID 或上游错误正文。

在 devserver 的 backend 目录运行：
    PYTHONPATH=. .venv/bin/python scripts/diagnostics/\
      test_responses_continuation_ab.py --allow-real-llm --preset Agnes

两组始终回放完整历史，不发送 ``previous_response_id``。唯一变量是是否保留并回放
模型 Responses 返回的 reasoning item，模拟“推理续接”关闭/开启。最多每组运行 5 次；
每组每次最多 3 个请求。
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


_INITIAL_PROMPT = "帮我查一下南京现在的天气，并看看未来两小时的大致情况。"
_FOLLOWUP_PROMPT = "那如果一会儿再出门呢？"
_INSTRUCTIONS = (
    "你正在进行一段普通中文对话。需要查询天气时使用 weather_lookup 工具；"
    "根据此前对话理解省略的城市和时间；用户追问‘一会儿’或‘稍后’时，"
    "调用 period=next_hour 查询，不要只凭已有信息推测。收到天气结果后，"
    "综合温度、降雨概率和时间比较，给出明确建议及简短依据；不得编造工具未返回的数据。"
    "weather_lookup 一次会返回当前天气和未来两小时预报，不要重复查询来补齐同一份数据。"
)
_TOOL_RESULT = json.dumps({
    "city": "南京",
    "period": "now",
    "current": {"temperature_c": 20.8, "condition": "局部多云", "precipitation_probability": 5},
    "hourly_forecast": [
        {"hours_from_now": 1, "temperature_c": 18.2, "condition": "小雨", "precipitation_probability": 72},
        {"hours_from_now": 2, "temperature_c": 17.5, "condition": "中雨", "precipitation_probability": 88},
    ],
}, ensure_ascii=False, separators=(",", ":"))
_TOOLS = [{
    "type": "function",
    "name": "weather_lookup",
    "description": (
        "查询天气。city 是城市名；period=now 以当前天气为查询焦点，"
        "period=next_hour 以大约一小时后的天气为查询焦点；每次调用都会同时返回当前及未来两小时预报。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "city": {"type": "string"},
            "period": {"type": "string", "enum": ["now", "next_hour"]},
        },
        "required": ["city", "period"],
        "additionalProperties": False,
    },
    "strict": True,
}]


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        result = dump()
        return result if isinstance(result, dict) else {}
    return {}


def _safe_token(value: Any) -> str | None:
    if value is None or isinstance(value, (dict, list)):
        return None
    text = re.sub(r"[^A-Za-z0-9_.:-]", "", str(value))[:80]
    return text or None


def _error_summary(exc: Exception) -> dict[str, Any]:
    response = getattr(exc, "response", None)
    status = getattr(exc, "status_code", None) or getattr(response, "status_code", None)
    return {
        "status": status if isinstance(status, int) else None,
        "exception": type(exc).__name__,
        "error_code": _safe_token(getattr(exc, "code", None)),
        "error_type": _safe_token(getattr(exc, "type", None)),
        "error_param": _safe_token(getattr(exc, "param", None)),
    }


def _response_data(completed: Any) -> dict[str, Any]:
    data = _as_dict(completed)
    if data:
        return data
    return {
        "id": getattr(completed, "id", None),
        "output": getattr(completed, "output", None),
        "output_text": getattr(completed, "output_text", None),
    }


def _output_items(response_data: dict[str, Any], item_type: str | None = None) -> list[dict[str, Any]]:
    output = response_data.get("output") or []
    return [
        item for value in output
        if (item := _as_dict(value)) and (item_type is None or item.get("type") == item_type)
    ]


def _output_text(response_data: dict[str, Any]) -> str:
    direct = response_data.get("output_text")
    if isinstance(direct, str) and direct:
        return direct
    chunks = []
    for item in _output_items(response_data):
        if item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            block = _as_dict(part)
            text = block.get("text")
            if isinstance(text, str):
                chunks.append(text)
    return "\n".join(chunks)


def _safe_weather_args(call: dict[str, Any]) -> dict[str, str | bool | None]:
    arguments = call.get("arguments")
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            arguments = {}
    if not isinstance(arguments, dict):
        arguments = {}
    city = str(arguments.get("city") or "").strip()
    period = str(arguments.get("period") or "").strip()
    return {
        "tool": call.get("name") == "weather_lookup",
        "city_is_nanjing": city in {"南京", "南京市", "Nanjing"},
        "period": period if period in {"now", "next_hour"} else "other",
    }


def _assistant_tool_input(call: dict[str, Any]) -> dict[str, Any]:
    call_id = call.get("call_id")
    item_id = call.get("id")
    if not isinstance(call_id, str) or not call_id or not isinstance(item_id, str) or not item_id:
        raise ValueError("Responses function_call 缺少可回放的 id")
    arguments = call.get("arguments")
    if not isinstance(arguments, str):
        arguments = json.dumps(arguments or {}, ensure_ascii=False, separators=(",", ":"))
    return {
        "type": "function_call",
        "id": item_id,
        "call_id": call_id,
        "name": str(call.get("name") or "weather_lookup"),
        "arguments": arguments,
    }


async def _request(client: Any, ai: Any, adapter: Any, input_items: list[dict[str, Any]],
                   *, reasoning_replay: bool, tool_choice: str = "auto") -> dict[str, Any]:
    request: dict[str, Any] = {
        "model": ai.model,
        "instructions": _INSTRUCTIONS,
        "input": input_items,
        "max_output_tokens": min(int(getattr(ai, "max_tokens", 2048) or 2048), 2048),
        "tools": _TOOLS,
        "tool_choice": tool_choice,
        "stream": True,
        "store": True,
    }
    request.update(adapter.build_responses_reasoning_params(ai))
    if reasoning_replay:
        replay_params = getattr(adapter, "build_responses_reasoning_replay_params", None)
        if callable(replay_params):
            request.update(replay_params(ai))

    stream = await client.responses.create(**request)
    completed_data: dict[str, Any] | None = None
    try:
        async for event in stream:
            event_type = str(getattr(event, "type", "") or "")
            if event_type == "response.completed":
                completed_data = _response_data(getattr(event, "response", None))
            elif event_type in {"response.failed", "error"}:
                event_error = _as_dict(getattr(event, "error", None))
                raise RuntimeError(
                "Responses stream error "
                    + json.dumps({
                        "code": _safe_token(event_error.get("code")),
                        "type": _safe_token(event_error.get("type")),
                    }, ensure_ascii=True)
                )
    finally:
        close = getattr(stream, "close", None)
        if callable(close):
            result = close()
            if asyncio.iscoroutine(result):
                await result
    if completed_data is None:
        raise RuntimeError("Responses 流结束时没有 completed 事件")
    return completed_data


async def _run_arm(client: Any, ai: Any, adapter: Any, arm: str) -> dict[str, Any]:
    reasoning_replay = arm == "reasoning_replay"
    result: dict[str, Any] = {
        "arm": arm,
        "stages": [],
        "followup_tool": {"tool": False, "city_is_nanjing": False, "period": "none"},
        "intent_preserved": False,
        "reasoning_items_replayed": False,
    }
    history: list[dict[str, Any]] = [{"role": "user", "content": _INITIAL_PROMPT}]
    try:
        first = await _request(
            client, ai, adapter, list(history), reasoning_replay=reasoning_replay,
            tool_choice="required",
        )
        first_id = first.get("id")
        calls = _output_items(first, "function_call")
        first_probe = _safe_weather_args(calls[0]) if calls else {
            "tool": False, "city_is_nanjing": False, "period": "none",
        }
        result["stages"].append({
            "name": "initial_weather_lookup",
            "completed": bool(first_id),
            "input_items": len(history),
            "reasoning_items_in_input": 0,
            "tool_probe": first_probe,
        })
        if not first_id or not calls or not first_probe["tool"]:
            return result

        call_item = _assistant_tool_input(calls[0])
        tool_output = {
            "type": "function_call_output",
            "call_id": call_item["call_id"],
            "output": _TOOL_RESULT,
        }
        history.extend(
            item for item in _output_items(first)
            if item.get("type") == "message"
            or (reasoning_replay and item.get("type") == "reasoning")
        )
        history.extend([call_item, tool_output])
        # 两组均走本地完整历史；只改变 reasoning item 是否作为可恢复状态回放。
        stage2_input = list(history)
        second = await _request(
            client, ai, adapter, stage2_input, reasoning_replay=reasoning_replay,
            tool_choice="none",
        )
        second_id = second.get("id")
        answer = _output_text(second)
        result["stages"].append({
            "name": "return_from_synthetic_tool",
            "completed": bool(second_id),
            "answer_present": bool(answer.strip()),
            "input_items": len(stage2_input),
            "reasoning_items_in_input": sum(item.get("type") == "reasoning" for item in stage2_input),
            "output_item_types": [str(item.get("type") or "unknown") for item in _output_items(second)],
            "status": _safe_token(second.get("status")),
            "incomplete_reason": _safe_token(
                (_as_dict(second.get("incomplete_details"))).get("reason")
            ),
            "output_tokens": (_as_dict(second.get("usage"))).get("output_tokens"),
        })
        if not second_id:
            return result
        if _output_items(second, "function_call"):
            result["stages"][-1]["unexpected_extra_tool_call"] = True
            return result
        history.extend(
            item for item in _output_items(second)
            if item.get("type") == "message"
            or (reasoning_replay and item.get("type") == "reasoning")
        )
        history.append({"role": "user", "content": _FOLLOWUP_PROMPT})
        third_input = list(history)
        third = await _request(
            client, ai, adapter, third_input, reasoning_replay=reasoning_replay,
            tool_choice="required",
        )
        third_id = third.get("id")
        calls = _output_items(third, "function_call")
        probe = _safe_weather_args(calls[0]) if calls else {
            "tool": False, "city_is_nanjing": False, "period": "none",
        }
        result["followup_tool"] = probe
        result["reasoning_items_replayed"] = bool(
            reasoning_replay
            and sum(item.get("type") == "reasoning" for item in third_input) > 0
        )
        result["intent_preserved"] = bool(
            third_id and probe["tool"] and probe["city_is_nanjing"] and probe["period"] == "next_hour"
        )
        result["stages"].append({
            "name": "implicit_weather_followup",
            "completed": bool(third_id),
            "input_items": len(third_input),
            "reasoning_items_in_input": sum(item.get("type") == "reasoning" for item in third_input),
            "sent_previous_response_id": False,
            "tool_probe": probe,
        })
    except Exception as exc:
        result["error"] = _error_summary(exc)
    return result


def _select_responses_preset(settings: Any, selector: str | None) -> Any:
    presets = list(getattr(getattr(settings, "ai_presets", None), "items", None) or [])
    active_id = str(getattr(getattr(settings, "ai_presets", None), "active_id", "") or "")
    if selector:
        needle = selector.strip().lower()
        candidates = [preset for preset in presets if needle in " ".join(
            str(getattr(preset, key, "")) for key in ("id", "name", "provider", "model")
        ).lower()]
    else:
        candidates = [preset for preset in presets if active_id and getattr(preset, "id", "") == active_id]
        if not candidates:
            candidates = [
                preset for preset in presets
                if str(getattr(preset, "api_format", "")).lower() == "responses"
            ]
    candidates = [preset for preset in candidates
                  if str(getattr(preset, "api_format", "")).lower() == "responses"]
    if len(candidates) != 1:
        raise RuntimeError("模型选择不唯一或目标不是 Responses 预设；请用 --preset 指定唯一预设")
    if not getattr(candidates[0], "api_key", ""):
        raise RuntimeError("选中的 Responses 预设没有配置 API Key")
    return candidates[0]


def _enable_probe_reasoning(ai: Any, adapter: Any) -> tuple[Any, dict[str, Any]]:
    """仅在内存副本启用模型已声明支持的推理，确保 A/B 真能观察推理回放。"""
    probe_ai = copy.copy(ai)
    capabilities = adapter.reasoning_capabilities(probe_ai, "responses")
    modes = tuple(getattr(capabilities, "modes", ()) or ())
    efforts = tuple(getattr(capabilities, "efforts", ()) or ())
    configured = {
        "thinking": str(getattr(ai, "thinking", "") or ""),
        "reasoning_effort": str(getattr(ai, "reasoning_effort", "") or ""),
    }
    forced = False
    if "adaptive" in modes and getattr(probe_ai, "thinking", "disabled") != "adaptive":
        probe_ai.thinking = "adaptive"
        forced = True
    if efforts and not getattr(probe_ai, "reasoning_effort", ""):
        preference = ("max", "xhigh", "high", "medium", "low", "minimal")
        probe_ai.reasoning_effort = next((item for item in preference if item in efforts), efforts[-1])
        forced = True
    return probe_ai, {
        "reasoning_generation_forced_for_probe": forced,
        "probe_thinking": str(getattr(probe_ai, "thinking", "") or ""),
        "probe_reasoning_effort": str(getattr(probe_ai, "reasoning_effort", "") or ""),
        "preset_unchanged": configured == {
            "thinking": str(getattr(ai, "thinking", "") or ""),
            "reasoning_effort": str(getattr(ai, "reasoning_effort", "") or ""),
        },
    }


async def run(args: argparse.Namespace) -> int:
    if not args.allow_real_llm:
        raise SystemExit("默认不联网；调用真实模型必须显式传入 --allow-real-llm")
    from app.core.config import get_settings
    from agent.providers import adapter_for, build_openai_client

    settings = get_settings()
    ai = _select_responses_preset(settings, args.preset)
    adapter = adapter_for(ai)
    if adapter.protocol_format(ai) != "responses":
        raise RuntimeError("所选预设的实际协议不是 Responses")
    ai, reasoning_probe = _enable_probe_reasoning(ai, adapter)

    import httpx

    client = build_openai_client(
        ai,
        httpx.Timeout(90.0, connect=15.0, read=90.0, write=15.0, pool=15.0),
    )
    reports = []
    try:
        # 交错执行先后顺序，降低短时服务波动对单一组别的偏差。
        for index in range(args.runs):
            arms = ("canonical_only", "reasoning_replay") if index % 2 == 0 else ("reasoning_replay", "canonical_only")
            for arm in arms:
                reports.append({"run": index + 1, **await _run_arm(client, ai, adapter, arm)})
    finally:
        await client.close()

    summary = {}
    for arm in ("canonical_only", "reasoning_replay"):
        rows = [row for row in reports if row["arm"] == arm]
        summary[arm] = {
            "runs": len(rows),
            "followup_intent_preserved": sum(bool(row["intent_preserved"]) for row in rows),
            "followup_weather_tool_called": sum(bool(row["followup_tool"]["tool"]) for row in rows),
            "runs_with_reasoning_replayed": sum(bool(row["reasoning_items_replayed"]) for row in rows),
            "errors": sum("error" in row for row in rows),
        }
    host = urlsplit(adapter.resolve_base_url(ai)).hostname
    payload = {
        "provider": str(getattr(ai, "provider", "unknown")),
        "api_format": "responses",
        "model": str(getattr(ai, "model", "")),
        "endpoint_host": host,
        **reasoning_probe,
        "synthetic_tool_result": True,
        "tools_executed": False,
        "requests_per_arm_max": 3,
        "summary": summary,
        "runs": reports,
    }
    serialized = json.dumps(payload, ensure_ascii=False, indent=2)
    print(serialized)
    if args.output:
        Path(args.output).write_text(serialized + "\n", encoding="utf-8")
    return 0 if all(
        summary[arm]["followup_intent_preserved"] == args.runs
        for arm in ("canonical_only", "reasoning_replay")
    ) and summary["reasoning_replay"]["runs_with_reasoning_replayed"] > 0 else 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-real-llm", action="store_true")
    parser.add_argument("--preset", help="按唯一预设 id、名称或模型名筛选；默认使用 active_id")
    parser.add_argument("--runs", type=int, default=3, help="每组重复次数，范围 1–5；默认 3")
    parser.add_argument("--output", help="可选：保存不含正文/凭据的 JSON 报告")
    args = parser.parse_args()
    if not 1 <= args.runs <= 5:
        parser.error("--runs 必须在 1 到 5 之间")
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
