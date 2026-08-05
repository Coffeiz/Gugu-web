"""按 MemoryScope 读取 IM 记忆文件。

上下文读取和反思写入都必须经过这个 scope 边界；这里不负责提取、压缩、
权限判断或删除流程，避免业务策略散落到存储层。
"""
from __future__ import annotations

from typing import Any, Dict

import json

from agent.memory.scopes import MemoryScope
from app.services.storage import get_storage


async def _read(scope: MemoryScope, filename: str) -> str:
    try:
        raw = await get_storage().get(scope.key(filename))
    except FileNotFoundError:
        return ""
    except Exception as exc:
        # OSS 的缺失对象表现为带 404/NoSuchKey 的 SDK 异常；其他错误必须继续
        # 抛出，不能把鉴权、网络或存储故障伪装成“没有记忆”。
        if getattr(exc, "status", None) == 404 or getattr(exc, "code", None) in {
            "NoSuchKey", "NoSuchBucket",
        }:
            return ""
        raise
    return raw.decode("utf-8", errors="replace").strip()


async def read_scope(scope: MemoryScope) -> Dict[str, Any]:
    """返回当前 scope 可用的原始文件内容，不解析、不推断、不写入。"""
    result: Dict[str, Any] = {}
    for filename in scope.files:
        text = await _read(scope, filename)
        key = filename.removesuffix(".json").removesuffix(".md")
        if filename.endswith(".json"):
            if not text:
                result[key] = {}
                continue
            try:
                value = json.loads(text)
            except (TypeError, ValueError):
                value = {}
            result[key] = value if isinstance(value, (dict, list)) else {}
        else:
            result[key] = text
    return result


async def write_scope_file(scope: MemoryScope, filename: str, text: str) -> None:
    """写入已校验 scope 的单个文件；调用方负责业务策略和成功后游标。"""
    from agent.memory.scope_lifecycle import is_tombstoned

    if await is_tombstoned(scope):
        return
    await get_storage().put(scope.key(filename), text.encode("utf-8"), "text/plain; charset=utf-8")


async def write_scope_json(scope: MemoryScope, filename: str, value: Any) -> None:
    if not filename.endswith(".json"):
        raise ValueError(f"不是 JSON 作用域文件: {filename}")
    await write_scope_file(
        scope,
        filename,
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
    )
