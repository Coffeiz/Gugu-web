"""用户级实时事件总线：Redis pub/sub → SSE。

咕咕通过工具改了数据（项目/日历/文件/客户），或 IM（飞书/QQ）来了新消息后，
往该用户的频道 publish 一条「资源变了」事件；网页端开一条 SSE 订阅该频道，
收到就刷新对应的 store。这样 **web 聊天和 IM 触发的改动都能实时反映到网页**。

挂点是 `registry.dispatch`（所有工具执行的唯一咽喉，web/IM 共用）+ runner 持久化后。
鉴权走 fetch streaming（带 Authorization 头），不依赖 EventSource。
"""
from __future__ import annotations

import asyncio
import json

from app.core.redis import get_redis

# 改动型工具 → 受影响的前端资源。只列「会变数据」的工具（list_/get_/read_ 等只读不列）。
# 新增改动型工具时记得在这里登记，否则网页不会实时刷新。
RESOURCE_BY_TOOL: dict[str, str] = {
    # 项目
    "create_project": "projects", "update_project": "projects", "delete_project": "projects",
    "archive_project": "projects", "update_stage": "projects", "set_priority": "projects",
    "set_color": "projects", "add_stage": "projects", "remove_stage": "projects",
    "rename_stage": "projects", "add_todo": "projects", "remove_todo": "projects",
    # 日历
    "create_event": "calendar", "update_event": "calendar", "delete_event": "calendar",
    # 文件库
    "edit_file": "files", "create_document": "files", "rename_file": "files",
    "move_file": "files", "copy_file": "files", "create_folder": "files",
    "delete_file": "files", "rename_folder": "files", "delete_folder": "files",
    "save_uploaded_file": "files",
    # 客户
    "create_client": "clients", "update_client": "clients", "delete_client": "clients",
    # 回收站（恢复/彻底删都影响文件库）
    "restore_file": "files", "permanent_delete": "files",
}


def _channel(user_id) -> str:
    return f"events:{user_id}"


async def publish(user_id, *resources: str, **extra) -> None:
    """通知某用户：若干资源已变化（best-effort，失败不影响主流程）。

    extra 里可带细粒度信息，如 session_id + appended（新消息增量），
    供前端把消息直接追加进当前打开的会话（消息级实时，不必整列表 refetch）。
    """
    payload: dict = {}
    res = [r for r in resources if r]
    if res:
        payload["resources"] = res
    for k, v in extra.items():
        if v is not None:
            payload[k] = v
    if not payload:
        return
    try:
        await get_redis().publish(_channel(user_id), json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


async def stream(user_id):
    """SSE 生成器：订阅该用户频道，把每条事件以 `data: {...}` 推给浏览器。

    无消息时每 ~20s 发一个注释行做 keepalive（防代理掐断空闲连接）。
    连接断开时 finally 里清理订阅。
    """
    pubsub = get_redis().pubsub()
    ch = _channel(user_id)
    await pubsub.subscribe(ch)
    try:
        yield ": connected\n\n"
        while True:
            try:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=20.0)
            except asyncio.CancelledError:
                raise
            except Exception:
                # 连接抖动：发个 keepalive，下轮重试
                yield ": retry\n\n"
                continue
            if msg is None:
                yield ": ping\n\n"
                continue
            data = msg.get("data")
            if data:
                yield f"data: {data}\n\n"
    finally:
        try:
            await pubsub.unsubscribe(ch)
            await pubsub.aclose()
        except Exception:
            pass
