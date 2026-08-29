"""用户级实时事件总线：Redis pub/sub → SSE。

咕咕通过工具改了数据（项目/日历/文件/客户），或 IM（飞书/QQ）来了新消息后，
往该用户的频道 publish 一条「资源变了」事件；网页端开一条 SSE 订阅该频道，
收到就刷新对应的 store。这样 **web 聊天和 IM 触发的改动都能实时反映到网页**。

挂点是 `registry.dispatch`（所有工具执行的唯一咽喉，web/IM 共用）+ runner 持久化后。
鉴权走 fetch streaming（带 Authorization 头），不依赖 EventSource。
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from app.core.redis import get_redis

_CONTEXT_RESOURCES = {"projects", "calendar", "files", "memory"}
# snapshot 新鲜度覆盖的输入比前端 SSE 资源集合更大。
_CONTEXT_REVISION_SOURCES = _CONTEXT_RESOURCES | {"preferences", "timezone", "im_channels"}
_DATA_RUNTIME_RESOURCES = {"projects", "files", "sessions", "conversation"}

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
    "note_create": "mind", "note_update": "mind", "note_delete": "mind",
    "note_restore": "mind", "note_undo": "mind",
    # 思维画布 Agent 工具
    "canvas_create": "mind", "canvas_create_note": "mind",
    "canvas_add_node": "mind", "canvas_update_node": "mind",
    "canvas_remove_node": "mind", "canvas_update_note": "mind",
    "canvas_delete_note": "mind", "canvas_connect": "mind",
    "canvas_update_anchor": "mind",
    "canvas_disconnect": "mind", "canvas_batch": "mind",
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


async def publish_data_runtime_invalidation(user_id, resource: str,
                                            *, operation: str = "refresh",
                                            scope_type: str = "owner",
                                            scope_id: str | None = None,
                                            revision: int | str | None = None) -> None:
    """向 TS Data Runtime 发布来源级失效事件；失败不影响业务写入。"""
    canonical = {"projects": "project", "files": "file", "sessions": "conversation"}.get(resource, resource)
    if canonical not in {"project", "file", "conversation"}:
        return
    try:
        payload = {
            "protocol_version": "data-runtime-invalidation-v1",
            "event_id": f"data-{uuid.uuid4().hex}",
            "owner_id": str(user_id),
            "resource": canonical,
            "scope_type": scope_type,
            "scope_id": scope_id or str(user_id),
            "operation": operation,
        }
        if revision is not None:
            payload["revision"] = revision
        redis = get_redis()
        await redis.publish(f"data-runtime:invalidate:{user_id}", json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass

async def publish(user_id, *resources: str, origin: str | None = None,
                  file_op: dict | None = None, operation: str | None = None,
                  entity_id: int | str | None = None,
                  entity_ids: list[int | str] | None = None,
                  event_payload: Any = None, **extra) -> None:
    """通知某用户：若干资源已变化（best-effort，失败不影响主流程）。

    - origin：发起这次改动的浏览器标签页 client-id（来自请求头 X-Client-Id）。前端收到
      自己发起的回声事件时据此**跳过**重拉（它已经乐观更新过了）。咕咕/IM 侧改动没有
      client-id，origin=None → 所有端都刷新（正确）。
    - file_op：文件库细粒度增量提示 {op, kind, id}，如 {"op":"remove","kind":"file","id":12}。
      统一转换到 canonical payload，前端对 remove 直接本地剔除，其余操作回退到合并刷新。
    - extra 里的 session_id/appended/title 只用于构造 canonical 会话事件 payload，不再作为
      顶层兼容字段输出。
    """
    payload: dict = {}
    res = [r for r in resources if r]
    await bump_context_revision(user_id, *res)
    if res:
        inferred_operation = operation or ((file_op or {}).get("op") if file_op else None)
        if inferred_operation is None and res[0] == "sessions":
            inferred_operation = "append" if extra.get("appended") is not None else (
                "update" if extra.get("title") is not None else "refresh"
            )
        inferred_operation = inferred_operation or "refresh"
        if inferred_operation == "remove":
            inferred_operation = "delete"
        canonical_resource = {"mind.canvas": "mind"}.get(res[0], res[0])
        # revision 的比较边界是资源而不是用户。用户级全局计数会让 A 资源
        # 的事件把 B 资源的 revision 撞出“缺口”，造成无意义的补刷。
        live_revision = 0
        try:
            redis = get_redis()
            revision_key = f"live-revision:{user_id}:{canonical_resource}"
            live_revision = int(await redis.incr(revision_key))
            await redis.expire(revision_key, 60 * 60 * 24 * 7)
        except Exception:
            pass
        payload.update({
            "protocol_version": "live-event-v1",
            "event_id": f"evt-{uuid.uuid4().hex}",
            "type": "resource.changed",
            "resource": canonical_resource,
            "operation": inferred_operation,
            "revision": live_revision,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        if entity_id is not None:
            payload["entity_id"] = entity_id
        if entity_ids is not None:
            payload["entity_ids"] = entity_ids
        if event_payload is not None:
            # 事件 payload 必须是 JSON 数据；API 层可以传 Pydantic 响应模型，
            # 这里统一转换，避免“业务已提交但事件因不可序列化而静默丢失”。
            if hasattr(event_payload, "model_dump"):
                event_payload = event_payload.model_dump(mode="json", by_alias=True)
            payload["payload"] = event_payload
        elif file_op:
            payload["payload"] = {
                "kind": file_op.get("kind"),
                "entity": {key: file_op[key] for key in ("id", "ids") if key in file_op},
            }
    if origin:
        payload["origin"] = origin
    # 会话事件只写入 canonical payload，不再同时输出旧的顶层 session_id/appended。
    if res and payload.get("resource") == "sessions":
        if payload.get("entity_id") is None and extra.get("session_id") is not None:
            payload["entity_id"] = extra["session_id"]
        session_payload = {
            key: extra[key]
            for key in ("appended", "title")
            if extra.get(key) is not None
        }
        if session_payload:
            payload["payload"] = session_payload
    if not payload:
        return
    try:
        await get_redis().publish(_channel(user_id), json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass
    for resource in res:
        if resource in _DATA_RUNTIME_RESOURCES:
            invalidation_operation = inferred_operation if res else (operation or "refresh")
            if invalidation_operation == "append":
                invalidation_operation = "update"
            await publish_data_runtime_invalidation(user_id, resource, operation=invalidation_operation)


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
