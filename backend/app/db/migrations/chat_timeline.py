"""仅供历史数据升级使用；运行时禁止从模型历史重建展示事件。"""
from __future__ import annotations

import json
from typing import Iterable

from agent.context.canonical_tool_history import _tool_result_is_error

_LEGACY_TOOL_LABELS = {"image_search": "图片搜索"}

def _tool_label(tool_name: str) -> str:
    """读取工具注册表中的用户可见名称，历史恢复时与实时 SSE 保持一致。"""
    try:
        from agent.tools import registry
        tool = registry.snapshot().get(tool_name)
        return str(tool.label if tool else _LEGACY_TOOL_LABELS.get(tool_name, tool_name))
    except Exception:
        # 历史数据可能包含已移除的旧工具；名称仍比丢失整条时间线更有用。
        return _LEGACY_TOOL_LABELS.get(tool_name, tool_name)


def _json_object(value: object) -> dict | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _adapter_tool_name(value: dict) -> str:
    target_name = str(value.get("tool_name") or value.get("name") or "").strip()
    if target_name:
        return target_name
    arguments = _json_object(value.get("arguments"))
    return str((arguments or {}).get("tool_name") or (arguments or {}).get("name") or "").strip()


def _display_tool_call(block: dict) -> tuple[str, object]:
    """把持久化的工具调用转换成聊天 UI 使用的业务工具名和参数。

    固定 Adapter 模式下，canonical history 必须保留外层 ``call_tool``，
    这样 provider 之间可以继续复用同一套历史协议；真实业务工具名在
    ``arguments.tool_name``（旧格式为 ``arguments.name``）中。这里仅在恢复 UI 工具气泡时解包，不能改写
    canonical history 本身。
    """
    tool_name = str(block.get("name") or "unknown_tool")
    tool_input = block.get("arguments", block.get("input", {}))
    adapter_input = _json_object(tool_input) or tool_input
    if tool_name == "call_tool" and isinstance(adapter_input, dict):
        target_name = _adapter_tool_name(adapter_input)
        target_arguments = _json_object(adapter_input.get("arguments"))
        if target_name:
            return target_name, target_arguments or {}
    return tool_name, tool_input


def _display_tool_result_name(block: dict) -> str:
    """兼容旧记录里结果块携带 Adapter 工具名的情况。"""
    tool_name = str(block.get("tool_name") or "").strip()
    if tool_name == "call_tool":
        result_input = block.get("input")
        if isinstance(result_input, dict):
            target_name = _adapter_tool_name(result_input)
            if target_name:
                return target_name
    return tool_name


def _tool_event_identity(call_id: str, message) -> tuple[str, str | None, str | None, str]:
    run_id = getattr(message, "run_id", None)
    round_id = getattr(message, "round_id", None)
    if run_id or round_id:
        identity = json.dumps([str(run_id or ""), str(round_id or ""), call_id], ensure_ascii=False, separators=(",", ":"))
        stable_id = f"tool:{identity}"
    else:
        identity = call_id
        stable_id = f"tool:{call_id}"
    return identity, str(run_id) if run_id else None, str(round_id) if round_id else None, stable_id


def _new_chat_tool_call_event(call_id: str, block: dict, message) -> tuple[str, dict]:
    identity, run_id, round_id, stable_id = _tool_event_identity(call_id, message)
    tool_name, tool_input = _display_tool_call(block)
    event = {
        "id": stable_id,
        "toolCallId": call_id,
        **({"runId": run_id} if run_id else {}),
        **({"roundId": round_id} if round_id else {}),
        "timelineOrder": message.id,
        "toolName": tool_name,
        "toolLabel": _tool_label(tool_name),
        "toolInput": tool_input,
        "toolStatus": "running",
        "createdAt": message.created_at,
    }
    batch_id = getattr(message, "canonical_batch_id", None)
    if batch_id is not None:
        event["canonicalBatchId"] = int(batch_id)
    return identity, event


def _new_chat_tool_result_event(call_id: str, block: dict, message) -> tuple[str, dict]:
    identity, run_id, round_id, stable_id = _tool_event_identity(call_id, message)
    tool_name = _display_tool_result_name(block) or "工具调用"
    return identity, {
        "id": stable_id,
        "toolCallId": call_id,
        **({"runId": run_id} if run_id else {}),
        **({"roundId": round_id} if round_id else {}),
        "timelineOrder": message.id,
        "toolName": tool_name,
        "toolLabel": _tool_label(tool_name) if tool_name != "工具调用" else "工具调用",
        "toolStatus": "running",
        "createdAt": message.created_at,
    }


def _apply_chat_tool_result(event: dict, block: dict, message) -> None:
    event["toolResult"] = block.get("content", "")
    event["toolStatus"] = "error" if _tool_result_is_error(block) else "success"
    # 工具调用和结果可能跨过消息分页窗口。以结果所在消息作为时间线位置，
    # 这样恢复当前窗口时仍能保留前面已经配对的工具名称和输入。
    event["timelineOrder"] = message.id
    event["updatedAt"] = message.created_at
    batch_id = getattr(message, "canonical_batch_id", None)
    if batch_id is not None:
        event["canonicalBatchId"] = int(batch_id)


def build_chat_tool_events(messages: Iterable) -> list[dict]:
    """把持久化的 canonical tool turn 聚合成聊天 UI 的工具气泡。"""
    # 不假设数据库中的块顺序永远是 call -> result。旧数据、跨 provider
    # 持久化或事务边界都可能让 result 先被扫描到；先收集调用，再合并结果，
    # 避免先创建「工具调用」占位事件后丢失真实工具名。
    events: dict[str, dict] = {}
    pending_results: list[tuple[str, str, dict, object]] = []
    for message in messages:
        content_json = getattr(message, "content_json", None)
        for index, block in enumerate(_blocks(content_json)):
            block_type = block.get("type")
            if block_type in ("tool_call", "tool_use"):
                call_id = str(block.get("id") or f"message-{message.id}-{index}")
                identity, event = _new_chat_tool_call_event(call_id, block, message)
                events[identity] = event
            elif block_type == "tool_result":
                call_id = str(block.get("tool_call_id") or block.get("tool_use_id") or "")
                if not call_id:
                    continue
                identity, _, _, _ = _tool_event_identity(call_id, message)
                pending_results.append((identity, call_id, block, message))

    for identity, call_id, block, message in pending_results:
        event = events.get(identity)
        if event is None:
            # 兼容历史中只保存结果块的异常记录；若结果带有 tool_name，
            # 仍可恢复具体名称，否则才退化为通用文案。
            event = events.setdefault(identity, _new_chat_tool_result_event(call_id, block, message)[1])
        _apply_chat_tool_result(event, block, message)
    return sorted(events.values(), key=lambda item: (item["createdAt"], item["id"]))


def _blocks(value) -> list[dict]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        return [value]
    return []



def migrate_session_timeline(rows: list) -> dict[int, list[dict] | None]:
    """将一个会话升级为单一展示源；不修改 canonical 正文，重复执行结果不变。"""
    from agent.media.images import strip_image_for_history

    groups: dict[str, list] = {}
    anchor = 0
    for row in rows:
        if row.role == "user" and row.content_json is None:
            anchor = row.id
        scope = str(row.run_id) if row.run_id else f"legacy-{anchor}"
        groups.setdefault(scope, []).append(row)
    updates: dict[int, list[dict] | None] = {}
    for scope, group in groups.items():
        canonical = build_chat_tool_events(group)
        by_call: dict[str, list[dict]] = {}
        for event in canonical:
            by_call.setdefault(event["toolCallId"], []).append(event)
        timelines: dict[int, list[dict]] = {row.id: [] for row in group}
        represented: dict[tuple, dict] = {}
        for row in group:
            for ordinal, raw in enumerate(row.display_timeline or []):
                if not isinstance(raw, dict):
                    continue
                item = strip_image_for_history(dict(raw))
                item["runId"] = str(item.get("runId") or row.run_id or scope)
                if item.get("kind") == "tool":
                    candidates = by_call.get(str(item.get("toolCallId") or ""), [])
                    matches = [event for event in candidates if not item.get("roundId") or event.get("roundId") == item["roundId"]]
                    event = candidates[0] if len(candidates) == 1 else (matches[0] if len(matches) == 1 else None)
                    if event:
                        item["roundId"] = event.get("roundId") or item.get("roundId") or row.round_id or f"legacy-call-{item.get('toolCallId')}"
                        for key in ("toolName", "toolLabel", "toolInput", "toolResult"):
                            if key in event:
                                item[key] = event[key]
                        if item.get("toolStatus") not in {"success", "error", "skipped", "cancelled", "stopped"}:
                            if event.get("toolStatus") in {"success", "error"}:
                                item["toolStatus"] = event["toolStatus"]
                    item["roundId"] = str(item.get("roundId") or row.round_id or f"legacy-{row.id}")
                    item["toolCallId"] = str(item.get("toolCallId") or f"legacy-{row.id}-{ordinal}")
                    key = (item["runId"], item["roundId"], item.get("toolCallId"))
                    if key in represented:
                        existing = represented[key]
                        duration = existing.get("toolDurationMs")
                        order = existing.get("timelineOrder")
                        if item.get("toolStatus") in {"success", "error", "stopped", "cancelled", "skipped"} or existing.get("toolStatus") not in {"success", "error", "stopped", "cancelled", "skipped"}:
                            existing.update(item)
                        else:
                            for name, value in item.items():
                                existing.setdefault(name, value)
                        if duration is not None:
                            existing["toolDurationMs"] = max(duration, item.get("toolDurationMs") or 0)
                        if order is not None:
                            existing["timelineOrder"] = order
                        continue
                    represented[key] = item
                item.setdefault("timelineOrder", row.id * 1000 + len(timelines[row.id]) + 1)
                timelines[row.id].append(item)
            # 一次性补齐旧时间线遗漏的附件，读取端无需再补。
            if timelines[row.id] and row.content_json is None and row.files and not any(item.get("files") for item in timelines[row.id]):
                timelines[row.id].append({"kind": "assistant", "text": "", "files": row.files})
        for event in canonical:
            run_id = str(event.get("runId") or scope)
            candidates = [key for key in represented if key[0] == run_id and key[2] == event["toolCallId"]
                          and (not event.get("roundId") or key[1] == event["roundId"])]
            if candidates:
                continue
            # 优先挂到同 run 的最终展示行之前，避免批量 canonical 落库时间造成倒序。
            target = next((row for row in reversed(group) if row.run_id and row.role == "assistant" and row.content_json is None), None)
            if target is None:
                target = next(row for row in group if row.id == event["timelineOrder"])
            if target.content_json is None and not timelines[target.id] and (target.content or target.files):
                timelines[target.id].append({"kind": "assistant", "text": target.content or "", "files": target.files or []})
            item = strip_image_for_history({key: value for key, value in event.items()
                      if key not in {"id", "createdAt", "updatedAt", "canonicalBatchId", "toolDurationMs", "timelineOrder"}})
            item.update(kind="tool", runId=run_id, roundId=str(event.get("roundId") or f"legacy-{target.id}"))
            if item["toolStatus"] == "running":
                item["toolStatus"] = "stopped"
            tools = timelines[target.id]
            position = next((i for i, value in enumerate(tools) if value.get("kind") == "assistant"), len(tools))
            tools.insert(position, item)
            represented[(run_id, item["roundId"], item["toolCallId"])] = item
        for row in group:
            value = timelines[row.id] or None
            if value:
                # 固定每个事件的顺序；详情索引与分页重载共用同一份持久数据。
                for index, item in enumerate(value):
                    item["runId"] = str(item.get("runId") or row.run_id or scope)
                    item["timelineOrder"] = value[0].get("timelineOrder", row.id * 1000) + index
                    if item.get("kind") == "tool" and item.get("toolStatus") in {"running", "queued", "waiting"}:
                        item["toolStatus"] = "stopped"
            if value != row.display_timeline:
                updates[row.id] = value
    return updates
