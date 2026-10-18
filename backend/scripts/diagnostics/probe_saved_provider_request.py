#!/usr/bin/env python3
"""隔离回放受控目录内的 SDK 请求体；不执行工具、不写数据库或运行配置。"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sqlite3
import time


async def replay(args, request: dict, output: Path) -> dict:
    import httpx

    from agent import providers
    from app.core.config import get_settings
    from scripts.diagnostics.probe_responses_trace_replay import safe_token

    presets = [item for item in get_settings().ai_presets.items
               if args.preset in (item.id, item.name, item.model)]
    if len(presets) != 1:
        raise ValueError("模型预设必须唯一匹配")
    preset = presets[0]
    # 只在当前进程切换协议，保留同协议端点，跨协议使用 Adapter 默认端点。
    ai = preset.model_copy(update={
        "api_format": args.protocol,
        "model": request["model"],
        "base_url": preset.base_url if preset.api_format == args.protocol else "",
    })
    timeout = httpx.Timeout(connect=15, read=120, write=15, pool=15)
    client = (providers.build_anthropic_client(ai, timeout)
              if args.protocol == "anthropic" else providers.build_openai_client(ai, timeout))
    endpoint = client.messages if args.protocol == "anthropic" else client.responses
    summary = {"protocol": args.protocol, "model": request["model"],
               "stream": request["stream"], "tools_executed": False, "events": {}}
    started = time.monotonic()
    try:
        if request["stream"]:
            # 原始 SSE 不经过 SDK 的事件模型解析，区分上游失败与 SDK 解析错误。
            async with endpoint.with_streaming_response.create(**request) as response:
                summary["http_status"] = response.status_code
                with (output / "raw-sse.txt").open("w", encoding="utf-8") as handle:
                    async for line in response.iter_lines():
                        handle.write(line + "\n")
                        if not line.startswith("data:") or not line[5:].strip() or line[5:].strip() == "[DONE]":
                            continue
                        event = json.loads(line[5:])
                        kind = event.get("type", "unknown")
                        summary["events"][kind] = summary["events"].get(kind, 0) + 1
                        if kind in {"response.completed", "response.incomplete", "response.failed"}:
                            data = event.get("response") or {}
                            summary["terminal"] = kind
                            summary["error_code"] = safe_token((data.get("error") or {}).get("code"))
                            summary["response_id"] = safe_token(data.get("id"))
                            summary["usage"] = data.get("usage")
                        elif kind == "error":
                            summary["terminal"] = "error"
                            summary["error_type"] = safe_token((event.get("error") or {}).get("type"))
                        elif kind == "message_stop":
                            summary["terminal"] = "completed"
        else:
            response = await endpoint.create(**request)
            data = response.model_dump()
            (output / "response.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            summary["terminal"] = data.get("status") or ("completed" if data.get("stop_reason") else "unknown")
            summary["stop_reason"] = safe_token(data.get("stop_reason"))
            summary["usage"] = data.get("usage")
            summary["error_code"] = safe_token((data.get("error") or {}).get("code"))
    except Exception as exc:
        summary["exception"] = type(exc).__name__
        summary["http_status"] = getattr(exc, "status_code", None)
        (output / "exception.json").write_text(
            json.dumps(getattr(exc, "body", None), ensure_ascii=False, default=str), encoding="utf-8",
        )
    finally:
        await client.close()
        summary["seconds"] = round(time.monotonic() - started, 2)
        (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-real-data", action="store_true")
    parser.add_argument("--allow-real-llm", action="store_true")
    origin = parser.add_mutually_exclusive_group(required=True)
    origin.add_argument("--request-json", type=Path)
    origin.add_argument("--trace-db", type=Path)
    parser.add_argument("--run-id")
    parser.add_argument("--round", type=int)
    parser.add_argument("--protocol", choices=("responses", "anthropic"), required=True)
    parser.add_argument("--preset")
    parser.add_argument("--model", help="仅覆盖请求中的模型名，用于单变量对照")
    parser.add_argument("--non-stream", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    if not args.allow_real_data:
        parser.error("读取真实请求必须显式传入 --allow-real-data")
    if not args.dry_run and not (args.allow_real_llm and args.preset and args.output_dir):
        parser.error("联网回放必须传入 --allow-real-llm、--preset 和 --output-dir")
    from agent.context.reasoning_state import fingerprint

    if args.trace_db:
        if not args.run_id or args.round is None:
            parser.error("读取 trace 必须指定 --run-id 与 --round")
        with sqlite3.connect(args.trace_db.resolve().as_uri() + "?mode=ro", uri=True) as db:
            rows = db.execute(
                "SELECT child.input_json FROM spans AS parent JOIN spans AS child "
                "ON child.parent_span_id=parent.id AND child.run_id=parent.run_id "
                "WHERE parent.run_id=? AND parent.kind='llm' AND parent.name=? "
                "AND child.name='Responses 失败请求' AND child.kind='context'",
                (args.run_id, f"LLM round {args.round}"),
            ).fetchmany(2)
        if len(rows) > 1:
            parser.error("该轮存在多份失败请求，拒绝不明确的回放")
        row = rows[0] if rows else None
        capture = (json.loads(row[0]).get("provider_request_capture") or {}) if row else {}
        if capture and capture.get("protocol") != args.protocol:
            parser.error("捕获协议与回放协议不同；不自动转换请求体")
        if not capture.get("replayable") or not isinstance(capture.get("request_json"), str):
            parser.error("该轮未保留可精确重放的请求；拒绝退回历史重建")
        request = json.loads(capture["request_json"])
        if fingerprint(request) != capture.get("request_digest"):
            parser.error("捕获请求的摘要不匹配，拒绝重放")
    else:
        request = json.loads(args.request_json.read_text(encoding="utf-8"))
    # 不允许将保存的客户端配置或认证头作为 SDK 请求体重新发送。
    forbidden = {"api_key", "authorization", "headers", "extra_headers", "base_url"}
    if not isinstance(request, dict) or forbidden.intersection(str(key).lower() for key in request):
        parser.error("只接受不含客户端认证字段的 SDK 请求体")
    if not isinstance(request.get("model"), str):
        parser.error("请求体缺少模型名")
    if args.model:
        request["model"] = args.model
    request.setdefault("stream", True)
    if args.non_stream:
        request["stream"] = False
    digest = fingerprint(request)
    if args.dry_run:
        print(json.dumps({"dry_run": True, "request_digest": digest, "keys": sorted(request),
                          "stream": request["stream"], "tools_executed": False}, ensure_ascii=False))
        return
    output = args.output_dir.resolve()
    if output.is_relative_to(Path(__file__).resolve().parents[3]):
        parser.error("原始调查产物必须保存在仓库外")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    output.chmod(0o700)
    (output / "request.json").write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    summary = asyncio.run(replay(args, request, output))
    print(json.dumps({**summary, "request_digest": digest}, ensure_ascii=False))


if __name__ == "__main__":
    main()
