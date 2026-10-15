"""Provider 缓存探针的请求与 usage 快照工具。"""
from __future__ import annotations

import copy
from typing import Any


def start_request_probe(sink: list | None, request: dict[str, Any]) -> dict[str, Any] | None:
    """记录 SDK 请求体；认证信息由 client 持有，不会出现在 request 中。"""
    if sink is None:
        return None
    snapshot = {"request": copy.deepcopy(request), "raw_usage": None, "normalized_usage": None}
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
