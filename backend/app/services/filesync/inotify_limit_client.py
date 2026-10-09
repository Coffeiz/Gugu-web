"""与宿主机受限 inotify limit helper 通信。"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any


SOCKET_PATH = os.getenv("FILESYNC__WATCH_LIMIT_SOCKET", "/run/gugu-inotify-limitd/limitd.sock")
MAX_WATCH_HARD_LIMIT = 1_024_000
BASE_WATCH_LIMIT = 65_536
EXPANSION_TIERS = (65_536, 131_072, 262_144, 524_288, 1_024_000)


class InotifyLimitUnavailable(RuntimeError):
    """宿主机 limit helper 不可用或拒绝请求。"""


def validate_hard_limit(value: Any) -> int:
    if type(value) is not int or not BASE_WATCH_LIMIT <= value <= MAX_WATCH_HARD_LIMIT:
        raise ValueError("watch_hard_limit 必须是 65536 到 1024000 之间的整数")
    return value


def validate_hard_limit_for_usage(value: int, usage: int) -> int:
    """Admin 可降低硬上限，但不能把它设到当前正在使用的 watcher 数以下。"""
    validate_hard_limit(value)
    if type(usage) is not int or usage < 0:
        raise ValueError("当前 watcher 使用量无效")
    if value < usage:
        raise ValueError("新的 watcher 硬上限不能低于当前实际监听数")
    return value


async def request_limit_agent(operation: str, hard_limit: int) -> dict[str, Any]:
    validate_hard_limit(hard_limit)
    if operation not in {"status", "auto_expand", "expand"}:
        raise ValueError("不支持的 inotify 管理操作")
    writer: asyncio.StreamWriter | None = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(SOCKET_PATH), timeout=2.0,
        )
        writer.write((json.dumps({"operation": operation, "hardLimit": hard_limit}) + "\n").encode())
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=3.0)
        if not line or len(line) > 4096:
            raise InotifyLimitUnavailable("宿主机 watcher 管理服务返回无效响应")
        result = json.loads(line)
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise InotifyLimitUnavailable("宿主机 watcher 管理服务拒绝请求")
        return result
    except (OSError, asyncio.TimeoutError, json.JSONDecodeError) as exc:
        raise InotifyLimitUnavailable("宿主机 watcher 管理服务不可用") from exc
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
