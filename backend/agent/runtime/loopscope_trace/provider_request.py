"""失败轮最终请求捕获，仅写入受控 LoopScope，不进入普通诊断日志。"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from typing import Any


def _has_credentials(value: Any) -> bool:
    from app.core.redaction import _CONN_RE, _KEY_RE

    if isinstance(value, dict):
        sensitive = {"authorization", "cookie", "api_key", "apikey", "password",
                     "access_token", "refresh_token", "client_secret", "secret", "token"}
        for key, item in value.items():
            if key == "authorization" and item == "user_sandbox":
                continue  # ask_user 的权限模式枚举不是认证凭据。
            # Schema 中的密码字段定义不是凭据值，继续检查其结构即可。
            if str(key).lower() in sensitive and isinstance(item, (str, int)) and item:
                return True
            if _has_credentials(item):
                return True
    elif isinstance(value, list):
        return any(_has_credentials(item) for item in value)
    elif isinstance(value, str):
        if _KEY_RE.search(value) or _CONN_RE.search(value):
            return True
        if value.lstrip().startswith(("{", "[")):
            try:
                return _has_credentials(json.loads(value))
            except (ValueError, RecursionError):
                return False  # 非 JSON 正文仍已经过上面的凭据模式检查。
    return False


def _exception_metadata(error: BaseException) -> dict[str, Any]:
    """只提取可用于分类上游故障的字段，不读取异常正文、请求或响应正文。"""
    chain: list[dict[str, Any]] = []
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen and len(chain) < 6:
        seen.add(id(current))
        item: dict[str, Any] = {"type": type(current).__name__}
        status = getattr(current, "status_code", None)
        response = getattr(current, "response", None)
        if status is None and response is not None:
            status = getattr(response, "status_code", None)
        if isinstance(status, int) and 100 <= status <= 599:
            item["status_code"] = status
        for key in ("code", "type", "param", "request_id"):
            value = getattr(current, key, None)
            if isinstance(value, str) and value and len(value) <= 128 \
                    and re.fullmatch(r"[A-Za-z0-9_.:-]+", value):
                item[key] = value
        chain.append(item)
        current = current.__cause__ or current.__context__
    return {"exception_chain": chain}


def record_failed_responses_request(
    request: dict, *, failure_kind: str, ai: Any, error: BaseException | None = None,
) -> None:
    """保留实际 SDK body；不能安全保留时明确标记不可重放，不篡改请求。"""
    from . import state

    if not state._enabled():
        return
    span = state._active_llm_span.get()
    if span is None or span.ended_at is not None or span.run is None:
        return
    capture = {"protocol": "responses", "failure_kind": failure_kind, "replayable": False}
    if error is not None:
        try:
            capture.update(_exception_metadata(error))
        except Exception:
            # 诊断字段提取失败不能遮蔽原始 Provider 错误。
            capture["exception_metadata_unavailable"] = True
    try:
        snapshot = copy.deepcopy(request)
        serialized = json.dumps(snapshot, ensure_ascii=False, sort_keys=True,
                                separators=(",", ":"), allow_nan=False)
        api_key = getattr(ai, "api_key", "")
        if hasattr(api_key, "get_secret_value"):
            api_key = api_key.get_secret_value()
        forbidden = {"api_key", "authorization", "headers", "extra_headers", "base_url"}
        if (forbidden.intersection(str(key).lower() for key in snapshot)
                or (isinstance(api_key, str) and len(api_key) >= 8 and api_key in serialized)
                or _has_credentials(snapshot)):
            capture["unavailable_reason"] = "credential_detected"
        else:
            capture.update({
                "replayable": True,
                "request_digest": hashlib.sha256(serialized.encode()).hexdigest(),
                "reasoning_item_count": sum(item.get("type") == "reasoning"
                                            for item in snapshot.get("input", []) if isinstance(item, dict)),
                # 作为完整 JSON 字符串穿过 trace 序列化，避免深层工具 Schema 被深度上限改写。
                "request_json": serialized,
            })
    except Exception as exc:
        # 观测失败不能替换原始 provider 异常，也不能将原始正文写到日志。
        capture.update(unavailable_reason="capture_failed", error_type=type(exc).__name__)
    try:
        captured = span.run.span(
            "context", "Responses 失败请求", {"provider_request_capture": capture},
            parent_span_id=span.id, provider_request_capture=True,
        )
        captured.finish({"replayable": capture["replayable"]})
    except Exception:
        pass
