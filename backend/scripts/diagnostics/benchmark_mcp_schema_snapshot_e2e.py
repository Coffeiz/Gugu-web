#!/usr/bin/env python3
"""对真实 Web Agent 请求做 MCP 实时发现与快照命中的端到端对照。"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid
from uuid import UUID

import sqlalchemy as sa


async def _resolve_target(user_id: str | None):
    from app.core.config import get_settings
    from app.db import session as db_session
    from app.models import User, UserMcpServer
    from agent.llm.llm_select import resolve_run_config_for_user

    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        if user_id:
            user = await db.get(User, UUID(user_id))
        else:
            users = list((await db.scalars(
                sa.select(User).join(
                    UserMcpServer, UserMcpServer.user_id == User.id,
                ).where(
                    User.is_active.is_(True), UserMcpServer.enabled.is_(True),
                ).distinct()
            )).all())
            if len(users) != 1:
                raise RuntimeError("需要 --user-id 指定唯一启用 MCP 的用户")
            user = users[0]
        if user is None or not user.is_active:
            raise RuntimeError("目标用户不可用")
        run_config = await resolve_run_config_for_user(
            get_settings(), db, user.id, None,
        )
        model = run_config.model
        if str(getattr(model, "provider", "")).lower() != "minimax":
            raise RuntimeError("目标用户当前模型不是 MiniMax")
        return user.id, user.username


async def _run_arm(label: str, user_id: UUID, user_name: str, *, force_live_discovery: bool) -> dict:
    from agent.gateway.web.stream import stream
    from agent.mcp.manager import mcp_manager
    from agent.models import AgentRequest

    # 两臂均用新 Web session 和同一短提示；每臂独立计时完整网关请求至 done。
    mcp_manager.invalidate_user(user_id)
    mcp_manager._snapshot_tool_cache.pop(mcp_manager._user_key(user_id), None)
    original_read = mcp_manager._read_schema_snapshot
    original_discover = mcp_manager._discover_user_tools
    discovery_ms: list[float] = []
    wire = {"provider_requests": [], "first_text_at": None}
    _WIRE_PROBE["active"] = wire

    async def no_snapshot(_uid):
        return None

    async def timed_discover(*args, **kwargs):
        started = time.perf_counter()
        try:
            return await original_discover(*args, **kwargs)
        finally:
            discovery_ms.append((time.perf_counter() - started) * 1000)

    if force_live_discovery:
        mcp_manager._read_schema_snapshot = no_snapshot
    mcp_manager._discover_user_tools = timed_discover
    request = AgentRequest(
        message="请直接回复“收到”。无需查询信息，不要调用任何工具。",
        user_id=user_id,
        user_name=user_name,
        source="web",
        locale="zh-CN",
        client_message_id=f"mcp-e2e-{uuid.uuid4().hex[:20]}",
    )
    started = time.perf_counter()
    session_id = None
    rounds = 0
    done = False
    error = False
    try:
        async for line in stream(request):
            for raw in line.splitlines():
                if not raw.startswith("data: "):
                    continue
                try:
                    event = json.loads(raw[6:])
                except (TypeError, ValueError):
                    continue
                kind = event.get("type")
                if kind == "session_id":
                    session_id = event.get("session_id")
                elif kind == "round_start":
                    rounds += 1
                elif kind == "token" and event.get("content") and wire["first_text_at"] is None:
                    wire["first_text_at"] = time.perf_counter()
                elif kind == "display_event":
                    item = event.get("item") or {}
                    if item.get("kind") == "assistant" and item.get("text") and wire["first_text_at"] is None:
                        wire["first_text_at"] = time.perf_counter()
                elif kind == "error":
                    error = True
                elif kind == "done":
                    done = True
                    break
            if done or error:
                break
    finally:
        _WIRE_PROBE["active"] = None
        mcp_manager._read_schema_snapshot = original_read
        mcp_manager._discover_user_tools = original_discover
    expected_path = bool(discovery_ms) if force_live_discovery else not discovery_ms
    provider_requests = wire["provider_requests"]
    first_provider = provider_requests[0] if provider_requests else {}
    request_started = started
    provider_start = first_provider.get("started_at")
    first_text_at = wire.get("first_text_at")
    return {
        "arm": label,
        "status": "ok" if done and rounds and not error and expected_path else "failed",
        "session_id": session_id,
        "rounds": rounds,
        "request_ms": round((time.perf_counter() - started) * 1000, 1),
        "message_to_provider_start_ms": round((provider_start - request_started) * 1000, 1)
        if provider_start else None,
        "provider_start_to_headers_ms": round(
            (first_provider["headers_at"] - provider_start) * 1000, 1,
        ) if provider_start and first_provider.get("headers_at") else None,
        "provider_start_to_first_body_ms": round(
            (first_provider["first_body_at"] - provider_start) * 1000, 1,
        ) if provider_start and first_provider.get("first_body_at") else None,
        "provider_http_duration_ms": round(
            (first_provider["body_complete_at"] - provider_start) * 1000, 1,
        ) if provider_start and first_provider.get("body_complete_at") else None,
        "message_to_provider_complete_ms": round(
            (first_provider["body_complete_at"] - request_started) * 1000, 1,
        ) if first_provider.get("body_complete_at") else None,
        "message_to_first_text_ms": round((first_text_at - started) * 1000, 1)
        if first_text_at else None,
        "provider_request_count": len(provider_requests),
        "mcp_discovery_ms": [round(value, 1) for value in discovery_ms],
        "used_snapshot": not force_live_discovery and expected_path,
    }


async def run(user_id: str | None) -> list[dict]:
    from agent.mcp.manager import mcp_manager

    _install_wire_probe()
    resolved_id, user_name = await _resolve_target(user_id)
    cold = await _run_arm(
        "A_live_discovery", resolved_id, user_name, force_live_discovery=True,
    )
    warm = await _run_arm(
        "B_database_snapshot", resolved_id, user_name, force_live_discovery=False,
    )
    # 尽量关闭探针进程建立的 MCP 客户端连接。
    for runtime in mcp_manager._runtimes_for_user(resolved_id):
        if runtime.client is not None:
            try:
                await runtime.client.aclose()
            except Exception:
                pass
    return [cold, warm]


_WIRE_PROBE = {"active": None, "installed": False}
_WIRE_EXTENSION = "gugu_mcp_schema_e2e_probe"


def _install_wire_probe() -> None:
    """在 SDK 请求钩子记录时点，不保留 URL、header、body 或 token 文本。"""
    if _WIRE_PROBE["installed"]:
        return
    import httpx2

    from agent.providers.client_pool import provider_client_pool

    original_get_sdk_client = provider_client_pool.get_sdk_client
    original_aiter_bytes = httpx2.Response.aiter_bytes

    async def on_request(request):
        active = _WIRE_PROBE.get("active")
        host = str(getattr(request.url, "host", "") or "").lower()
        if active is None or not _is_minimax_host(host):
            return
        request_state = {"started_at": time.perf_counter()}
        request.extensions[_WIRE_EXTENSION] = request_state
        active["provider_requests"].append(request_state)

    async def on_response(response):
        request = getattr(response, "request", None)
        request_state = getattr(request, "extensions", {}).get(_WIRE_EXTENSION)
        if request_state is not None:
            request_state["headers_at"] = time.perf_counter()

    def instrumented_get_sdk_client(key, timeout, factory):
        def instrumented_factory(http_client=None):
            client = factory(http_client)
            if http_client is not None:
                http_client.event_hooks["request"].append(on_request)
                http_client.event_hooks["response"].append(on_response)
            return client

        return original_get_sdk_client(key, timeout, instrumented_factory)

    async def tracked_aiter_bytes(response, *args, **kwargs):
        request_state = getattr(
            getattr(response, "request", None), "extensions", {},
        ).get(_WIRE_EXTENSION)
        try:
            async for chunk in original_aiter_bytes(response, *args, **kwargs):
                if request_state is not None and chunk:
                    request_state.setdefault("first_body_at", time.perf_counter())
                yield chunk
        finally:
            if request_state is not None:
                request_state["body_complete_at"] = time.perf_counter()

    provider_client_pool.get_sdk_client = instrumented_get_sdk_client
    httpx2.Response.aiter_bytes = tracked_aiter_bytes
    _WIRE_PROBE["restore"] = (provider_client_pool, original_get_sdk_client, httpx2, original_aiter_bytes)
    _WIRE_PROBE["installed"] = True


def _is_minimax_host(host: str) -> bool:
    return host in {"minimax.io", "minimaxi.com", "minimax.cn"} or host.endswith(
        (".minimax.io", ".minimaxi.com", ".minimax.cn"),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", help="启用 MCP 的用户 UUID；省略时仅接受唯一用户")
    parser.add_argument("--allow-real-data", action="store_true")
    parser.add_argument("--allow-real-llm", action="store_true")
    args = parser.parse_args()
    if not args.allow_real_data or not args.allow_real_llm:
        parser.error("端到端探针会写入两条测试会话并调用真实 MiniMax，需显式传入两个 allow 开关")
    try:
        results = asyncio.run(run(args.user_id))
    except Exception as exc:
        print(json.dumps({"status": "error", "error_type": type(exc).__name__}))
        return 1
    print(json.dumps({"results": results}, ensure_ascii=False, indent=2))
    return 0 if all(result["status"] == "ok" for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
