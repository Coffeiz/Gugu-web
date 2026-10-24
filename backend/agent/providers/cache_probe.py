"""Provider 缓存探针的请求与 usage 快照工具。"""
from __future__ import annotations

import copy
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from typing import Any


def start_request_probe(sink: list | None, request: dict[str, Any]) -> dict[str, Any] | None:
    """记录 SDK 请求体；认证信息由 client 持有，不会出现在 request 中。"""
    if sink is None:
        return None
    snapshot = {
        "request": copy.deepcopy(request),
        "raw_usage": None,
        "normalized_usage": None,
        "request_started_at": datetime.now(timezone.utc).isoformat(),
        "_request_started_monotonic": time.monotonic(),
        "wire_prefix": _wire_prefix_summary(request),
    }
    sink.append(snapshot)
    return snapshot


def finish_usage_probe(probe: dict[str, Any] | None, raw_usage: Any, normalized: dict[str, Any]) -> None:
    """同时保存原始字段形状和归一化值，便于辨别缺失字段与显式零值。"""
    if probe is None:
        return
    if isinstance(raw_usage, dict):
        raw = dict(raw_usage)
    elif hasattr(raw_usage, "model_dump"):
        try:
            raw = raw_usage.model_dump(exclude_none=False)
        except Exception:
            raw = raw_usage
    elif hasattr(raw_usage, "__dict__"):
        raw = {key: value for key, value in vars(raw_usage).items() if not key.startswith("_")}
    else:
        raw = raw_usage
    probe["raw_usage"] = raw
    probe["normalized_usage"] = normalized
    probe["outcome"] = "success"
    probe["response_received_at"] = datetime.now(timezone.utc).isoformat()
    started = probe.pop("_request_started_monotonic", None)
    if isinstance(started, (int, float)):
        probe["request_duration_ms"] = round(max(0.0, time.monotonic() - started) * 1000, 3)


def fail_request_probe(probe: dict[str, Any] | None, error: BaseException) -> None:
    """记录失败尝试的分类与时长，不读取异常正文或上游响应正文。"""
    if probe is None:
        return
    probe["response_received_at"] = datetime.now(timezone.utc).isoformat()
    probe["outcome"] = "error"
    probe["error_type"] = type(error).__name__
    status = getattr(error, "status_code", None)
    response = getattr(error, "response", None)
    if status is None and response is not None:
        status = getattr(response, "status_code", None)
    if isinstance(status, int) and 100 <= status <= 599:
        probe["error_status"] = status
    code = getattr(error, "code", None)
    if isinstance(code, (str, int)) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", str(code)):
        probe["error_code"] = str(code)
    started = probe.pop("_request_started_monotonic", None)
    if isinstance(started, (int, float)):
        probe["request_duration_ms"] = round(max(0.0, time.monotonic() - started) * 1000, 3)


def _wire_prefix_summary(request: dict[str, Any]) -> dict[str, Any]:
    """生成不含正文的最终 wire 前缀摘要与缓存断点位置。"""
    try:
        rows_key = "messages" if isinstance(request.get("messages"), list) else (
            "input" if isinstance(request.get("input"), list) else ""
        )
        rows = request.get(rows_key, []) if rows_key else []
        anchor_paths: list[str] = []

        def find_anchors(value: Any, path: str) -> None:
            if isinstance(value, dict):
                marker = value.get("cache_control")
                if isinstance(marker, dict) and marker.get("type"):
                    anchor_paths.append(path)
                for key, item in value.items():
                    find_anchors(item, f"{path}.{key}" if path else str(key))
            elif isinstance(value, list):
                for index, item in enumerate(value):
                    find_anchors(item, f"{path}[{index}]")

        find_anchors(request, "")
        prefix_end = max((i for i, row in enumerate(rows)
                          if _contains_cache_control(row)), default=len(rows) - 1)
        prefix_rows = rows[:prefix_end + 1] if prefix_end >= 0 else []
        base = {key: value for key, value in request.items()
                if key not in {"messages", "input", "stream"}}
        digest_payload = {"base": base, "rows_key": rows_key, "rows": prefix_rows}
        encoded = json.dumps(digest_payload, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), default=str).encode("utf-8")
        text_chars = 0
        block_count = 0

        def count_text(value: Any) -> None:
            nonlocal text_chars, block_count
            if isinstance(value, dict):
                if isinstance(value.get("text"), str):
                    text_chars += len(value["text"])
                    block_count += 1
                elif isinstance(value.get("content"), str):
                    text_chars += len(value["content"])
                    block_count += 1
                for item in value.values():
                    if isinstance(item, (dict, list)):
                        count_text(item)
            elif isinstance(value, list):
                for item in value:
                    count_text(item)

        count_text(prefix_rows)
        return {
            "digest": hashlib.sha256(encoded).hexdigest(),
            "rows_key": rows_key or None,
            "prefix_row_count": len(prefix_rows),
            "request_row_count": len(rows),
            "text_block_count": block_count,
            "text_char_count": text_chars,
            "anchor_paths": anchor_paths,
            "anchor_index_basis": "wire row index; paths identify nested block positions",
        }
    except Exception:
        return {"available": False}


def _contains_cache_control(value: Any) -> bool:
    if isinstance(value, dict):
        marker = value.get("cache_control")
        if isinstance(marker, dict) and marker.get("type"):
            return True
        return any(_contains_cache_control(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_cache_control(item) for item in value)
    return False
