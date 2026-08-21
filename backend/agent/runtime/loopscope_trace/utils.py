from __future__ import annotations

import functools
import hashlib
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

def _prompt_digest(value: Any) -> str:
    """给 LoopScope 标记 prompt 身份；只传摘要，不在每个 round 重复传正文。"""
    try:
        text = value if isinstance(value, str) else json.dumps(
            _jsonable(value), ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    except Exception:
        return ""


def _cache_diagnostics(messages: Any, ctx: Any = None) -> dict[str, Any]:
    """返回缓存断点与工具 schema 的脱敏诊断信息。

    这里只记录大小、数量、位置和摘要，不能通过这些字段还原工具定义、参数、
    URL、图片或用户正文。诊断失败时返回空值，不影响模型请求。
    """
    try:
        conversation = getattr(messages, "conversation", messages)
        if not isinstance(conversation, list):
            conversation = []
        anchors = getattr(messages, "cache_anchor_indices", []) or []
        anchors = [int(index) for index in anchors if isinstance(index, int)]
        tools = getattr(ctx, "tools", None) or []
        tool_json = json.dumps(
            _jsonable(tools), ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        volatile_index = None
        try:
            from agent.loop_drivers import _contains_volatile_image

            for index, message in enumerate(conversation):
                if _contains_volatile_image(message):
                    volatile_index = index
                    break
        except Exception:
            pass

        stable_message_count = volatile_index if volatile_index is not None else len(conversation)
        anchor_token_estimate = 0
        if anchors:
            last_anchor = max(anchors)
            anchor_token_estimate = _estimate_tokens(conversation[:last_anchor + 1])
        return {
            "cache_supported": bool(getattr(ctx, "supports_active_cache", False)),
            "conversation_messages": len(conversation),
            "cache_anchor_count": len(anchors),
            "cache_anchor_last_index": max(anchors) if anchors else None,
            "cache_anchor_tokens_estimate": anchor_token_estimate,
            "volatile_image_present": volatile_index is not None,
            "volatile_image_first_index": volatile_index,
            "stable_message_count": stable_message_count,
            "tool_count": len(tools),
            "tool_schema_bytes": len(tool_json.encode("utf-8")),
            "tool_schema_tokens_estimate": _estimate_tokens(tool_json),
            "tool_schema_digest": hashlib.sha256(tool_json.encode("utf-8")).hexdigest()[:16],
        }
    except Exception:
        return {}

def _system_message_text(messages: Any) -> str:
    """提取 OpenAI 兼容格式的 system message，供 trace 说明真实组装位置。"""
    if not isinstance(messages, list):
        return ""
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "system":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(
                str(block.get("text") or "")
                for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
    return ""

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
