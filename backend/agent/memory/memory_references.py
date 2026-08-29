"""压缩阶段的历史事件参考选择。

这里只负责把当前 daily 批次转换成 BM25 查询，并返回受限、脱敏的历史参考；
压缩失败时调用方必须继续使用当前 daily，不得把召回当作事实来源。
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

REFERENCE_LIMIT = 10
REFERENCE_MAX_CHARS = 6000
QUERY_MAX_CHARS = 2000


def build_reference_query(daily_entries: Iterable[str]) -> str:
    """用当前批次的日期和事实构造稳定查询，不引入 profile/pattern。"""
    return "\n".join(str(item).strip() for item in daily_entries if str(item).strip())[:QUERY_MAX_CHARS]


def _render_reference(item: dict[str, Any]) -> str:
    title = str(item.get("title") or "历史事件").strip()
    text = str(item.get("text") or "").strip()
    if not text:
        return ""
    return f"## {title}\n{text}"


async def retrieve_event_references(
    user_id,
    daily_entries: Iterable[str],
    *,
    limit: int = REFERENCE_LIMIT,
) -> list[dict[str, str]]:
    """召回最多 10 条 owner memory 事件，失败返回空列表。"""
    query = build_reference_query(daily_entries)
    if not query:
        return []
    try:
        from agent.rag.scope import owner_scope
        from agent.rag.service import search_memory

        result = await search_memory(
            user_id, query, scope=owner_scope(user_id), source="memory",
            strategy="bm25", limit=min(max(1, int(limit)), REFERENCE_LIMIT),
            mode="memory-compaction",
        )
        seen: set[str] = set()
        references: list[dict[str, str]] = []
        used = 0
        for item in result.get("results", []) if isinstance(result, dict) else []:
            text = _render_reference(item)
            key = str(item.get("content_hash") or text).strip()
            if not text or key in seen or used >= REFERENCE_MAX_CHARS:
                continue
            text = text[:REFERENCE_MAX_CHARS - used].rstrip()
            if not text:
                continue
            references.append({"text": text, "content_hash": key})
            seen.add(key)
            used += len(text)
            if len(references) >= REFERENCE_LIMIT:
                break
        return references
    except Exception:
        return []


def render_event_references(references: Iterable[dict[str, str]]) -> str:
    """渲染历史参考标记，不暴露 chunk、scope 或 score。"""
    rows = ["【历史事件参考，仅用于去重和背景核对】"]
    rows.extend(item["text"] for item in references if item.get("text"))
    return "\n\n".join(rows) if len(rows) > 1 else "（暂无相关历史事件参考）"


__all__ = [
    "REFERENCE_LIMIT", "REFERENCE_MAX_CHARS", "build_reference_query",
    "retrieve_event_references", "render_event_references",
]
