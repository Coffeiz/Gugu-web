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

_CONTEXT_RESOURCES = {"projects", "calendar", "files", "memory"}
# snapshot 新鲜度覆盖的输入比前端 SSE 资源集合更大。
_CONTEXT_REVISION_SOURCES = _CONTEXT_RESOURCES | {"preferences", "timezone", "im_channels"}

# 改动型工具 → 受影响的前端资源。只列「会变数据」的工具（list_/get_/read_ 等只读不列）。
# 新增改动型工具时记得在这里登记，否则网页不会实时刷新。
RESOURCE_BY_TOOL: dict[str, str] = {
    # 项目
    "create_project": "projects", "update_project": "projects", "delete_project": "projects",
    "archive_project": "projects", "update_stage": "projects",
    "set_color": "projects", "add_stage": "projects", "remove_stage": "projects",
    "rename_stage": "projects", "add_todo": "projects", "remove_todo": "projects",
    "set_stages": "projects", "update_todo": "projects",
    # 日历
    "create_event": "calendar", "update_event": "calendar", "delete_event": "calendar",
    # 文件库
    "edit_file": "files", "create_document": "files", "rename_file": "files",
    "move_items": "files", "copy_file": "files", "create_folder": "files",
    "delete_file": "files", "rename_folder": "files", "delete_folder": "files",
    "save_uploaded_file": "files",
    # 客户
    "create_client": "clients", "update_client": "clients", "delete_client": "clients",
    # 定时任务（咕咕建/改/删 → 网页定时面板实时刷）
    "create_scheduled_task": "scheduled_tasks", "update_scheduled_task": "scheduled_tasks",
    "delete_scheduled_task": "scheduled_tasks",
    # 回收站（恢复/彻底删都影响文件库）
    "restore_file": "files", "permanent_delete": "files",
    # 思维画布便签
    "create_note": "mind", "update_note": "mind", "delete_note": "mind",
    "restore_note": "mind", "undo_last_gugu_note": "mind",
    # 思维画布 Agent 工具
    "mind_create_canvas": "mind", "mind_create_canvas_note": "mind",
    "mind_add_canvas_node": "mind", "mind_update_canvas_node": "mind",
    "mind_remove_canvas_node": "mind", "mind_update_canvas_note": "mind",
    "mind_delete_canvas_note": "mind", "mind_connect_nodes": "mind",
    "mind_update_relation_anchor": "mind",
    "mind_disconnect_nodes": "mind", "mind_batch_canvas": "mind",
}


def _channel(user_id) -> str:
    return f"events:{user_id}"


async def get_context_revision(user_id) -> int:
    """读取用户业务上下文版本；不存在时从 0 开始。"""
    try:
        value = await get_redis().get(f"context-revision:{user_id}")
        return int(value or 0)
    except Exception:
        return 0


async def bump_context_revision(user_id, *resources: str) -> None:
    """业务数据成功变更后递增版本，供 session snapshot 做新鲜度判断。"""
    # 兼容 mind.canvas 的旧调用签名：publish(user_id, resource, action, payload)
    # 后两个位置参数可能是字典，版本判断只消费字符串资源名。
    resource_names = {resource for resource in resources if isinstance(resource, str)}
    if not _CONTEXT_REVISION_SOURCES.intersection(resource_names):
        return
    try:
        key = f"context-revision:{user_id}"
        redis = get_redis()
        await redis.incr(key)
        await redis.expire(key, 60 * 60 * 24 * 7)
    except Exception:
        pass


async def publish(user_id, *resources: str, origin: str | None = None,
                  file_op: dict | None = None, **extra) -> None:
    """通知某用户：若干资源已变化（best-effort，失败不影响主流程）。

    - origin：发起这次改动的浏览器标签页 client-id（来自请求头 X-Client-Id）。前端收到
      自己发起的回声事件时据此**跳过**重拉（它已经乐观更新过了）。咕咕/IM 侧改动没有
      client-id，origin=None → 所有端都刷新（正确）。
    - file_op：文件库细粒度增量提示 {op, kind, id}，如 {"op":"remove","kind":"file","id":12}。
      前端对 remove 直接本地剔除（零网络），其余（add/update/移动/批量）回退到合并刷新。
    - extra 里可带别的细粒度信息，如 session_id + appended（新消息增量），供前端把消息
      直接追加进当前打开的会话（消息级实时，不必整列表 refetch）。
    """
    payload: dict = {}
    res = [r for r in resources if r]
    await bump_context_revision(user_id, *res)
    if res:
        payload["resources"] = res
    if origin:
        payload["origin"] = origin
    if file_op:
        payload["fileOp"] = file_op
    for k, v in extra.items():
        if v is not None:
            payload[k] = v
    if not payload:
        return
    try:
        await get_redis().publish(_channel(user_id), json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


BROADCAST_CHANNEL = "events:__broadcast__"


async def broadcast(title: str, content: str = "", color: str = "#7b7fb2", nid=None,
                    bubble: bool = True, persist: bool = True) -> None:
    """向所有在线用户推送通知（best-effort）。nid=site_notifications.id（供前端去重/标已读）；
    bubble=是否弹气泡，persist=是否进通知中心——前端按这俩决定怎么处理。"""
    notification = {"id": nid, "title": title, "content": content, "color": color,
                    "bubble": bubble, "persist": persist}
    payload = {"notification": notification}
    try:
        await get_redis().publish(BROADCAST_CHANNEL, __import__("json").dumps(payload, ensure_ascii=False))
    except Exception:
        pass


async def stream(user_id):
    """SSE 生成器：订阅该用户频道 + 全局广播频道，把每条事件以 `data: {...}` 推给浏览器。

    无消息时每 ~20s 发一个注释行做 keepalive（防代理掐断空闲连接）。
    连接断开时 finally 里清理订阅。
    """
    pubsub = get_redis().pubsub()
    ch = _channel(user_id)
    await pubsub.subscribe(ch, BROADCAST_CHANNEL)
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
