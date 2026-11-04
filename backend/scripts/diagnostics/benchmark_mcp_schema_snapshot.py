#!/usr/bin/env python3
"""对照 MCP 旧式实时发现与数据库 schema 快照读取耗时。"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import time
from uuid import UUID

import sqlalchemy as sa

from app.core.config import get_settings
from app.db import session as db_session
from app.models import User, UserMcpServer
from agent.mcp.manager import McpToolManager


def _tool_digest(tools) -> str:
    rows = [{
        "name": tool.name,
        "description": tool.provider_description,
        "input_schema": tool.input_schema,
    } for tool in tools]
    raw = json.dumps(rows, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


async def _resolve_user(user_id: str | None) -> UUID:
    if user_id:
        return UUID(user_id)
    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        ids = list((await db.scalars(
            sa.select(User.id).join(
                UserMcpServer, UserMcpServer.user_id == User.id,
            ).where(
                User.is_active.is_(True), UserMcpServer.enabled.is_(True),
            ).distinct()
        )).all())
    if len(ids) != 1:
        raise RuntimeError("需要通过 --user-id 指定唯一启用 MCP 的用户")
    return ids[0]


async def run(user_id: UUID) -> dict:
    manager = McpToolManager()
    settings = get_settings()
    configs = [config async for config in manager._iter_enabled_configs(user_id)]
    config_digest = manager._config_digest(configs)

    start = time.perf_counter()
    legacy_tools = await manager._discover_user_tools(
        user_id, settings=settings, configs=configs,
    )
    legacy_ms = (time.perf_counter() - start) * 1000
    if not manager._discovery_succeeded(user_id, configs):
        raise RuntimeError("MCP 实时发现未全部成功，拒绝写入 A/B 快照")
    legacy_digest = _tool_digest(legacy_tools)

    start = time.perf_counter()
    await manager._write_schema_snapshot(user_id, config_digest, legacy_tools)
    write_ms = (time.perf_counter() - start) * 1000

    manager._runtimes.clear()
    manager._snapshot_tool_cache.clear()
    start = time.perf_counter()
    snapshot_tools = await manager.list_user_tools(user_id)
    snapshot_ms = (time.perf_counter() - start) * 1000
    snapshot_digest = _tool_digest(snapshot_tools)
    return {
        "status": "ok" if legacy_digest == snapshot_digest else "schema_mismatch",
        "configured_servers": len(configs),
        "tool_count": len(legacy_tools),
        "legacy_live_discovery_ms": round(legacy_ms, 1),
        "snapshot_write_ms": round(write_ms, 1),
        "snapshot_read_ms": round(snapshot_ms, 1),
        "schema_digest_equal": legacy_digest == snapshot_digest,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", help="测试用户 UUID；省略时仅接受唯一启用用户")
    parser.add_argument(
        "--allow-real-data", action="store_true",
        help="确认允许读取真实数据库并连接启用的 MCP 服务",
    )
    args = parser.parse_args()
    if not args.allow_real_data:
        parser.error("诊断会读取数据库并连接 MCP 服务；运行时必须显式传入 --allow-real-data")
    try:
        async def main_async():
            return await run(await _resolve_user(args.user_id))

        result = asyncio.run(main_async())
    except Exception as exc:
        print(json.dumps({"status": "error", "error_type": type(exc).__name__}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
