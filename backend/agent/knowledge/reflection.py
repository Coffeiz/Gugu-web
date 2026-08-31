"""Knowledge 反思协议和 Memory 反思链路的轻量执行器。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


_PROMPT = Path(__file__).parent.parent / "prompts" / "knowledge-reflection.md"
_ACTIONS = {"create", "update", "conflict", "ignore"}
def load_prompt() -> str:
    return _PROMPT.read_text(encoding="utf-8").strip()


def build_request(
    user_message: str,
    assistant_message: str,
    candidates: list[dict[str, Any]] | tuple[dict[str, Any], ...],
    *,
    save_mode: str = "automatic",
) -> str:
    """构造脱敏边界内的反思输入，候选最多 5 条。"""
    compact = []
    for item in list(candidates)[:5]:
        compact.append({
            "id": str(item.get("source_id") or item.get("id") or ""),
            "title": str(item.get("title") or "")[:80],
            "topic": str(item.get("topic") or "")[:40],
            "text": str(item.get("text") or item.get("content") or "")[:1000],
            "source_type": str(item.get("source_type") or item.get("source") or ""),
            "confidence": str(item.get("confidence") or "confirmed"),
            "source_ref": str(item.get("source_ref") or "")[:300],
        })
    payload = {
        "save_mode": save_mode if save_mode in {"automatic", "explicit"} else "automatic",
        "user_message": str(user_message or ""),
        "assistant_message": str(assistant_message or ""),
        "knowledge_candidates": compact,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def normalize_operations(raw: object, *, save_mode: str = "automatic") -> list[dict[str, Any]]:
    """验证并裁剪模型输出；非法操作整体丢弃，避免写入越界字段。"""
    from agent.knowledge.capture import normalize_capture

    if not isinstance(raw, dict) or not isinstance(raw.get("operations"), list):
        return []
    result = []
    for value in raw["operations"]:
        if not isinstance(value, dict):
            continue
        action = str(value.get("action") or "").strip().lower()
        if action not in _ACTIONS:
            continue
        certainty = str(value.get("certainty") or value.get("confidence") or "probable").strip().lower()
        item: dict[str, Any] = {
            "action": action,
            "target_id": str(value.get("target_id") or "").strip(),
            "title": str(value.get("title") or "").strip(),
            "topic": str(value.get("topic") or "").strip(),
            "content": str(value.get("content") or "").strip(),
            "certainty": certainty,
            "reason": str(value.get("reason") or "").strip()[:200],
        }
        if item["certainty"] not in {"confirmed", "probable"}:
            item["certainty"] = "probable"
        if save_mode != "explicit":
            item["certainty"] = "probable"
        if action != "ignore":
            try:
                normalized = normalize_capture(
                    item["title"], item["content"], topic=item["topic"],
                    source_type="user" if save_mode == "explicit" else "conversation",
                    source_ref="conversation:reflection",
                    source_label="用户明确保存" if save_mode == "explicit" else "对话反思",
                    confidence=item["certainty"], capture_mode=save_mode,
                )
            except ValueError:
                continue
            item["title"], item["topic"], item["content"] = (
                normalized["title"], normalized["topic"], normalized["content"]
            )
        result.append(item)
    return result


def candidate_request(out: object) -> tuple[bool, str]:
    """读取 Memory 反思给出的候选信号，不把自由文本当作触发条件。"""
    if not isinstance(out, dict):
        return False, ""
    value = out.get("knowledge_candidate")
    if not isinstance(value, dict) or value.get("should_reflect") is not True:
        return False, ""
    query = str(value.get("query") or "").strip()[:200]
    return bool(query), query


async def reflect_if_candidate(
    user_id: object,
    user_message: str,
    assistant_message: str,
    settings,
    candidate_query: str,
    *,
    save_mode: str = "automatic",
    session_id: object | None = None,
) -> int:
    """候选命中后执行一次 Knowledge RAG + 专用反思，并写入主数据。"""
    from agent.rag.service import search_knowledge
    from agent.knowledge.capture import build_entry
    from agent.knowledge.store import KnowledgeStore
    from agent.context.branch import ContextBranch
    from agent.context.branch_types import BranchInput, BranchPolicy

    recall = await search_knowledge(
        user_id, candidate_query, scope="auto", source="knowledge",
        strategy="auto", limit=5, mode="reflection",
    )
    candidates = list(recall.get("results") or [])[:5]
    request = build_request(
        user_message, assistant_message, candidates, save_mode=save_mode,
    )
    # Knowledge 反思与 Memory 反思共用同一分支组装和重试审计；revision
    # 由本次候选查询稳定生成，避免 scope 更新时污染主对话 history。
    import hashlib
    scope_revision = hashlib.sha256(
        f"knowledge:{candidate_query}".encode("utf-8")
    ).hexdigest()[:16]
    branch = await ContextBranch().run(
        BranchInput(
            stable_system=load_prompt(),
            delta=request,
            scope="knowledge",
            scope_revision=scope_revision,
            session_id=int(session_id) if isinstance(session_id, int) else None,
        ),
        BranchPolicy(name="knowledge", output_mode="json", max_tokens=900),
        settings,
    )
    raw = branch.output if branch.ok else {}
    operations = normalize_operations(raw, save_mode=save_mode)
    saved = 0
    store = KnowledgeStore(user_id)
    for operation in operations[:3]:
        if operation["action"] == "ignore":
            continue
        source_type = "user" if save_mode == "explicit" else "conversation"
        source_ref = f"conversation:{session_id}" if session_id else "conversation:reflection"
        entry = build_entry(user_id, {
            "title": operation["title"], "content": operation["content"],
            "topic": operation["topic"], "source_type": source_type,
            "source_ref": source_ref,
            "source_label": "用户明确保存" if save_mode == "explicit" else "对话反思",
            "confidence": operation["certainty"],
        })
        if operation["action"] == "conflict":
            entry.parent_id = operation["target_id"] or None
            entry.id = f"knowledge-{__import__('uuid').uuid4().hex}"
        elif operation["target_id"]:
            entry.id = operation["target_id"]
        await store.save(entry)
        saved += 1
    return saved


__all__ = [
    "build_request", "candidate_request", "load_prompt",
    "normalize_operations", "reflect_if_candidate",
]
