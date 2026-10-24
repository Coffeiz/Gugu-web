"""展示事件写入时按调用身份更新。"""
from uuid import uuid4

from app.core.tz import now_utc


def stamp_display_item(item: dict, *, sequence: int, user_message_id: int) -> dict:
    """首次产生即固定身份、时间和位置；后续状态更新不改变这些字段。"""
    timestamp = now_utc().isoformat()
    item.setdefault("eventId", uuid4().hex)
    item.setdefault("sequence", sequence)
    item.setdefault("anchorMessageId", user_message_id)
    item.setdefault("createdAt", timestamp)
    item["updatedAt"] = timestamp
    item["timelineOrder"] = item["anchorMessageId"] * 1_000_000 + item["sequence"]
    return item


def upsert_tool_timeline_item(items: list[dict], incoming: dict) -> None:
    """保留首次出现的位置；同一调用后续状态覆盖原项。"""
    call_id = incoming.get("toolCallId")
    if incoming.get("kind") == "tool" and call_id:
        identity = (incoming.get("runId"), incoming.get("roundId"), call_id)
        for item in reversed(items):
            if item.get("kind") != "tool":
                continue
            if (item.get("runId"), item.get("roundId"), item.get("toolCallId")) == identity:
                # 重放的排队/执行事件不能覆盖已确认的终态。
                if item.get("toolStatus") in {"success", "error", "skipped", "cancelled", "stopped"}:
                    if incoming.get("toolStatus") in {"queued", "running", "waiting"}:
                        return
                metadata = {key: item[key] for key in ("eventId", "createdAt", "sequence", "anchorMessageId", "timelineOrder") if key in item}
                item.update(incoming)
                item.update(metadata)
                return
    items.append(dict(incoming))


def finalize_display_timeline(items: list[dict]) -> list[dict]:
    """只封存终态，不在收尾阶段补造事件身份或重排列表。"""
    timeline = [dict(item) for item in items]
    for item in timeline:
        if item.get("kind") == "tool" and item.get("toolStatus") in {"queued", "running"}:
            item["toolStatus"] = "stopped"
            item["updatedAt"] = now_utc().isoformat()
    return timeline
