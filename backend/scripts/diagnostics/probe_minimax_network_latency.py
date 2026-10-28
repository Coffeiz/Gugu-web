#!/usr/bin/env python3
"""隔离测量 MiniMax Anthropic 请求的连接、首事件与总耗时。

只发合成短文本，不读取会话、用户记忆或工具。真实 Provider 请求默认关闭，
必须显式传入 --allow-real-llm；配置密钥、URL、响应正文均不输出。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from urllib.parse import urlsplit


_ALLOWED_HOST_SUFFIXES = (".minimax.io", ".minimaxi.com", ".minimax.cn")
_ALLOWED_HOSTS = {"minimax.io", "minimaxi.com", "minimax.cn"}


class _ProbeFailure(Exception):
    def __init__(self, stage: str, error_type: str):
        super().__init__(stage)
        self.stage = stage
        self.error_type = error_type


def _safe_status(error: BaseException) -> int | None:
    status = getattr(error, "status_code", None)
    response = getattr(error, "response", None)
    if status is None and response is not None:
        status = getattr(response, "status_code", None)
    return status if isinstance(status, int) and 100 <= status <= 599 else None


async def _run_probe(runs: int) -> dict:
    stage = "load_config"
    # Anthropic SDK 当前使用 httpx2，必须将同一类型的客户端传给它。
    import httpx2 as httpx
    from anthropic import AsyncAnthropic

    from app.core.config import get_settings

    settings = get_settings()
    ai = settings.ai
    if str(getattr(ai, "provider", "")).lower() != "minimax":
        # 全局默认模型可能与 Agent 当前模型不同；仅在配置中恰好有一个
        # MiniMax preset 时使用它，避免探针误打到其他服务或猜选多个账号。
        minimax_presets = [
            item for item in getattr(settings.ai_presets, "items", [])
            if str(getattr(item, "provider", "")).lower() == "minimax"
        ]
        if len(minimax_presets) != 1:
            raise RuntimeError("没有唯一的 MiniMax preset 可供探测")
        ai = minimax_presets[0]
    api_key = str(getattr(ai, "api_key", "") or "")
    base_url = str(getattr(ai, "base_url", "") or "")
    model = str(getattr(ai, "model", "") or "")
    host = (urlsplit(base_url).hostname or "").lower()
    if not api_key or not model:
        raise RuntimeError("MiniMax API 配置不完整")
    if host not in _ALLOWED_HOSTS and not any(host.endswith(suffix) for suffix in _ALLOWED_HOST_SUFFIXES):
        raise RuntimeError("配置地址不属于允许的 MiniMax 官方域名")

    active: dict[str, dict] = {}

    async def on_request(request: httpx.Request) -> None:
        state = active.get("state")
        if state is None:
            return
        state["request_started"] = time.perf_counter()

        async def on_httpcore_trace(event_name: str, _info: dict) -> None:
            now = time.perf_counter()
            if event_name.endswith(".started"):
                state.setdefault("transport_phases", {}).setdefault(
                    event_name[:-8], now,
                )
            elif event_name.endswith(".complete"):
                key = event_name[:-9]
                phase_start = state.get("transport_phases", {}).pop(key, None)
                if phase_start is not None:
                    state.setdefault("transport_ms", {})[key.rsplit(".", 1)[-1]] = round(
                        (now - phase_start) * 1000, 1,
                    )

        # httpcore trace 只保留阶段名与耗时；不记录请求 URL、headers 或 payload。
        request.extensions["trace"] = on_httpcore_trace

    async def on_response(response: httpx.Response) -> None:
        state = active.get("state")
        if state is not None:
            state["headers_received"] = time.perf_counter()

    stage = "create_http_client"
    try:
        http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(45.0, connect=10.0),
            event_hooks={"request": [on_request], "response": [on_response]},
        )
    except Exception as error:
        raise _ProbeFailure(stage, type(error).__name__) from None
    stage = "create_provider_client"
    try:
        client = AsyncAnthropic(
            api_key=api_key,
            base_url=base_url,
            http_client=http_client,
            max_retries=0,
        )
    except Exception as error:
        await http_client.aclose()
        raise _ProbeFailure(stage, type(error).__name__) from None
    samples = []
    try:
        for index in range(runs):
            state: dict = {"transport_phases": {}, "transport_ms": {}}
            state["stage"] = "send_request"
            active["state"] = state
            started = time.perf_counter()
            state["request_started"] = started
            try:
                stream = await client.messages.create(
                    model=model,
                    max_tokens=8,
                    stream=True,
                    messages=[{
                        "role": "user",
                        "content": "Reply with the single word OK.",
                    }],
                )
                state["stage"] = "read_stream"
                async for event in stream:
                    now = time.perf_counter()
                    state.setdefault("first_event", now)
                    if (
                        getattr(event, "type", "") == "content_block_delta"
                        and getattr(getattr(event, "delta", None), "type", "") == "text_delta"
                    ):
                        state.setdefault("first_text", now)
                ended = time.perf_counter()
                headers_at = state.get("headers_received")
                samples.append({
                    "index": index + 1,
                    "request_to_headers_ms": round((headers_at - started) * 1000, 1)
                    if headers_at else None,
                    "headers_to_first_event_ms": round(
                        (state["first_event"] - headers_at) * 1000, 1,
                    ) if headers_at and state.get("first_event") else None,
                    "headers_to_first_text_ms": round(
                        (state["first_text"] - headers_at) * 1000, 1,
                    ) if headers_at and state.get("first_text") else None,
                    "total_ms": round((ended - started) * 1000, 1),
                    "transport_ms": state.get("transport_ms", {}),
                    "status": "ok",
                })
            except Exception as error:
                samples.append({
                    "index": index + 1,
                    "total_ms": round((time.perf_counter() - started) * 1000, 1),
                    "transport_ms": state.get("transport_ms", {}),
                    "status": "error",
                    "stage": state.get("stage", "unknown"),
                    "error_type": type(error).__name__,
                    "http_status": _safe_status(error),
                })
    finally:
        active.clear()
        await client.close()
    return {"provider": "minimax", "protocol": "anthropic", "model": model, "samples": samples}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-real-llm", action="store_true", help="确认发送真实、计费的 MiniMax 探针请求")
    parser.add_argument("--runs", type=int, default=3, help="顺序请求次数，范围 1–5，默认 3")
    args = parser.parse_args()
    if not args.allow_real_llm:
        parser.error("真实 Provider 请求默认关闭；确认后传入 --allow-real-llm")
    if not 1 <= args.runs <= 5:
        parser.error("--runs 必须在 1 到 5 之间")

    try:
        result = asyncio.run(_run_probe(args.runs))
    except Exception as error:
        # 不打印异常正文，防止 SDK 错误携带 endpoint、headers 或响应内容。
        print(json.dumps({
            "status": "error",
            "stage": getattr(error, "stage", None),
            "error_type": getattr(error, "error_type", type(error).__name__),
        }, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if all(item.get("status") == "ok" for item in result["samples"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
