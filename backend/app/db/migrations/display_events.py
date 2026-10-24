"""本版本一次性迁移展示事件身份；运行时不再识别旧展示协议。"""
from datetime import timezone
from uuid import NAMESPACE_URL, uuid5


def migrate_display_events(rows: list) -> dict[int, list[dict]]:
    updates = {}
    anchors = {row.id for row in rows if row.role == "user" and row.content_json is None}
    anchor = 0
    counters: dict[int, int] = {}
    for row in rows:
        if row.id in anchors:
            anchor = row.id
        items = row.display_timeline
        if not items and row.role == "assistant" and row.content_json is None and (row.content or row.files):
            items = [{"kind": "assistant", "text": row.content or "", "files": row.files or []}]
        if not items:
            continue
        run_ids = {item["runId"] for item in items if item.get("runId")}
        run_id = next(iter(run_ids)) if len(run_ids) == 1 else row.run_id or f"migrated-run:{row.id}"
        timestamp = row.created_at.replace(tzinfo=row.created_at.tzinfo or timezone.utc).isoformat()
        timeline = []
        for index, raw in enumerate(items):
            item = dict(raw)
            old_anchor = int(item.get("timelineOrder", 0)) // 1000
            event_anchor = int(item.get("anchorMessageId") or (old_anchor if old_anchor in anchors else anchor) or row.id)
            counters[event_anchor] = counters.get(event_anchor, 0) + 1
            item.setdefault("eventId", uuid5(NAMESPACE_URL, f"gugu-display:{row.session_id}:{row.id}:{index}").hex)
            item.setdefault("anchorMessageId", event_anchor)
            item.setdefault("sequence", counters[event_anchor])
            item["runId"] = item.get("runId") or run_id
            item["roundId"] = item.get("roundId") or row.round_id or f"migrated-round:{row.id}:{index}"
            item.setdefault("createdAt", timestamp)
            item.setdefault("updatedAt", item["createdAt"])
            item["timelineOrder"] = item["anchorMessageId"] * 1_000_000 + item["sequence"]
            timeline.append(item)
        if timeline != row.display_timeline:
            updates[row.id] = timeline
    return updates
