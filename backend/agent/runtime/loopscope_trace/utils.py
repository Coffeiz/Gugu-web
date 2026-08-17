from __future__ import annotations

import functools
import inspect
import json
import os
from typing import Any

def _jsonable(value: Any, depth: int = 0) -> Any:
    """把 provider/tool/ORM 对象安全变成 JSON；观测失败时宁可 repr，也不影响主链路。"""
    if depth > 8:
        return "<max-depth>"
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v, depth + 1) for v in value]
    if hasattr(value, "model_dump"):
        try:
            return _jsonable(value.model_dump(), depth + 1)
        except Exception:
            pass
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        try:
            public = {k: v for k, v in vars(value).items() if not k.startswith("_")}
            return _jsonable(public, depth + 1)
        except Exception:
            pass
    try:
        return repr(value)[:12000]
    except Exception:
        return f"<{type(value).__name__}>"

def _display_source_path(path: str | os.PathLike[str] | None) -> str:
    if not path:
        return ""
    raw = str(path).replace("\\", "/")
    for marker in ("/backend/", "/frontend/", "/loopscope/"):
        if marker in raw:
            return marker.strip("/") + "/" + raw.split(marker, 1)[1]
    return raw

def _code_ref(target: Any = None, *, frame_depth: int = 1) -> dict[str, Any]:
    """返回稳定的源码位置描述。失败返回空 dict，绝不影响业务。"""
    try:
        if target is None:
            frame = inspect.currentframe()
            for _ in range(frame_depth + 1):
                frame = frame.f_back if frame is not None else None
            if frame is None:
                return {}
            return {
                "file": _display_source_path(frame.f_code.co_filename),
                "module": frame.f_globals.get("__name__", ""),
                "function": frame.f_code.co_name,
                "qualname": getattr(frame.f_code, "co_qualname", frame.f_code.co_name),
                "line": frame.f_lineno,
            }

        while isinstance(target, functools.partial):
            target = target.func
        target = inspect.unwrap(target)
        file = inspect.getsourcefile(target) or inspect.getfile(target)
        try:
            line = inspect.getsourcelines(target)[1]
        except Exception:
            line = None
        return {
            "file": _display_source_path(file),
            "module": getattr(target, "__module__", ""),
            "function": getattr(target, "__name__", type(target).__name__),
            "qualname": getattr(target, "__qualname__", getattr(target, "__name__", type(target).__name__)),
            "line": line,
        }
    except Exception:
        return {}

def _estimate_tokens(value: Any) -> int:
    """Context/Tool 贡献的本地估算；真实 LLM usage 仍以 provider 返回为准。"""
    try:
        from agent.context.tokens import estimate_tokens
        if isinstance(value, str):
            text = value
        else:
            text = json.dumps(_jsonable(value), ensure_ascii=False, separators=(",", ":"))
        return estimate_tokens(text)
    except Exception:
        return 0

def _usage_payload(result: Any, api_format: str = "") -> dict[str, Any]:
    if result is None:
        return {}
    reported_input = int(getattr(result, "usage_in", 0) or 0)
    output = int(getattr(result, "usage_out", 0) or 0)
    cache_read = int(getattr(result, "cache_tokens", 0) or 0)
    cache_write = int(getattr(result, "cache_write_tokens", 0) or 0)
    # 现有 driver 的语义：OpenAI/DeepSeek prompt_tokens 已包含 cache hit；Anthropic
    # input_tokens 与 cache_read_input_tokens 分列。0.2 在观测层做归一，不改变 core 的旧 usage。
    if api_format == "anthropic":
        input_total = reported_input + cache_read + cache_write
        fresh_input = reported_input
    else:
        input_total = reported_input
        fresh_input = max(input_total - cache_read, 0)
    return {
        "input": input_total,
        "output": output,
        "cache_read": cache_read,
        "cache_write": cache_write,
        "fresh_input": fresh_input,
        "total": input_total + output,
        "cache_ratio": round(cache_read / input_total, 6) if input_total else 0,
    }

def _extract_last_user(messages: Any) -> str:
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            bits = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    bits.append(str(block.get("text") or ""))
            return "\n".join(bits)
    return ""

def _round_result(result: Any, api_format: str = "") -> dict[str, Any]:
    if result is None:
        return {}
    calls = []
    for tc in getattr(result, "tool_calls", None) or []:
        calls.append({
            "name": getattr(tc, "name", ""),
            "input": _jsonable(getattr(tc, "input", {})),
            "parse_error": bool(getattr(tc, "parse_error", False)),
        })
    return {
        "draft": getattr(result, "text", "") or "",
        "tool_calls": calls,
        "usage": _usage_payload(result, api_format),
    }

def _classify_followup(text: str) -> str:
    if "内部核验" in text or "需要查询" in text:
        return "verification"
    if "工具" in text and ("调用" in text or "执行" in text):
        return "tool-use guard"
    if "意图" in text or "当场" in text:
        return "intent guard"
    if "用户" in text and ("明确" in text or "要求" in text):
        return "decision guard"
    return "follow-up guard"
