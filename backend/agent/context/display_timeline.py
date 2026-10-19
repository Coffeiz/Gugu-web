"""工具展示时间线按调用身份更新，兼容历史重复状态项。"""


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
                item.update(incoming)
                return
    items.append(dict(incoming))


def merge_tool_timeline_items(items: list[dict]) -> list[dict]:
    """读取时合并旧记录，不修改数据库中的原始时间线。"""
    merged: list[dict] = []
    for item in items:
        upsert_tool_timeline_item(merged, item)
    return merged
