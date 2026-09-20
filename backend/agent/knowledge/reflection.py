"""Knowledge 反思协议和 Memory 反思链路的轻量执行器。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


_PROMPT = Path(__file__).parent.parent / "prompts" / "knowledge-reflection.md"
_ACTIONS = {"create", "update", "conflict", "ignore"}
def load_prompt() -> str:
    return _PROMPT.read_text(encoding="utf-8").strip()


def build_append_request(
    candidates: list[dict[str, Any]] | tuple[dict[str, Any], ...],
    *,
    save_mode: str = "automatic",
) -> str:
    """构造追加分支请求；本轮正文已在 history_messages 中，不重复放入 delta。"""
    return _serialize_request(candidates, save_mode=save_mode)


def _serialize_request(
    candidates: list[dict[str, Any]] | tuple[dict[str, Any], ...],
    *,
    save_mode: str,
) -> str:
    """序列化反思请求的公共载荷。"""
    compact = []
    for item in list(candidates)[:5]:
        compact.append({
            "id": str(item.get("source_id") or item.get("id") or ""),
            "title": str(item.get("title") or "")[:80],
            "topic": str(item.get("topic") or "")[:40],
            "text": str(item.get("text") or item.get("content") or "")[:3000],
            "source_type": str(item.get("source_type") or item.get("source") or ""),
            "confidence": str(item.get("confidence") or "confirmed"),
            "source_ref": str(item.get("source_ref") or "")[:300],
        })
    payload = {
        "save_mode": save_mode if save_mode in {"automatic", "explicit"} else "automatic",
        "user_message": "（已在追加历史中提供）",
        "assistant_message": "（已在追加历史中提供）",
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
            "keywords": value.get("keywords") if isinstance(value.get("keywords"), list) else [],
            "description": str(value.get("description") or "").strip(),
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
                    keywords=item["keywords"], description=item["description"],
                    source_type="user" if save_mode == "explicit" else "conversation",
                    source_ref="conversation:reflection",
                    source_label="用户明确保存" if save_mode == "explicit" else "对话反思",
                    confidence=item["certainty"], capture_mode=save_mode,
                )
            except ValueError:
                continue
            item["title"], item["topic"], item["content"], item["keywords"] = (
                normalized["title"], normalized["topic"], normalized["content"], normalized["keywords"]
            )
            item["description"] = normalized["description"]
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


# 仅 append_reuse 路径追加（PRD-LLM-27 §6.4）：完整历史只用于理解上下文，
# operations 只针对输入 JSON 里的待反思回合与知识候选——Knowledge 与 Memory
# 是共享同一前缀的 sibling branch，各自 delta 独立组装，互不继承对方输出。
_KNOWLEDGE_HISTORY_DIRECTIVE = (
    "【完整历史的使用边界】上面提供了本会话的完整历史，仅用于理解本次待反思回合的"
    "指代与背景；operations 只针对输入 JSON 中的待反思回合与知识候选，"
    "不要为历史内容新建任何操作。"
)


async def reflect_if_candidate(
    user_id: object,
    user_message: str,
    assistant_message: str,
    settings,
    candidate_query: str,
    *,
    save_mode: str = "automatic",
    session_id: object | None = None,
    snapshot: object | None = None,
) -> int:
    """候选命中后执行一次 Knowledge RAG + 专用反思，并写入主数据。

    snapshot（PRD-LLM-27 §6.4）：Knowledge 只在有主会话快照且资格一致时
    作为 sibling branch 复用同一前缀；没有可复用前缀时延迟本次反思，不创建
    没有主会话历史的独立调用。
    """
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
    request = build_append_request(candidates, save_mode=save_mode)
    # Knowledge 反思与 Memory 反思共用同一分支组装和重试审计；revision
    # 由本次候选查询稳定生成，避免 scope 更新时污染主对话 history。
    import hashlib
    scope_revision = hashlib.sha256(
        f"knowledge:{candidate_query}".encode("utf-8")
    ).hexdigest()[:16]
    # §6.4 sibling branch：只复用同一主会话快照（同一前缀、同一渲染出口）；
    # 专用规则与输入 JSON 按边界进 delta。快照缺失/会话不一致/provider 切换时
    # 延迟本次 Knowledge 反思，避免恢复已断开的前缀。
    use_append = (
        snapshot is not None
        and isinstance(session_id, int)
        and snapshot.session_id == session_id
    )
    if use_append:
        from agent.context.reflection_snapshot import model_identity
        from agent.llm.modelctx import effective_ai

        if model_identity(snapshot.ai) != model_identity(effective_ai(settings)):
            use_append = False
    if not use_append:
        return []
    from agent.context.prefix_history import render_branch_prefix

    branch_input = BranchInput(
        stable_system=snapshot.system_prompt,
        delta=(
            load_prompt() + "\n\n"
            + _KNOWLEDGE_HISTORY_DIRECTIVE + "\n\n"
            + request
        ),
        scope="knowledge",
        scope_revision=scope_revision,
        session_id=int(session_id),
        run_id=snapshot.run_id,
        history_messages=tuple(render_branch_prefix(list(snapshot.history), snapshot.ai)),
        tools=tuple(snapshot.tools),
        branch_mode="append_reuse",
    )
    branch = await ContextBranch().run(
        branch_input,
        BranchPolicy(name="knowledge", output_mode="json", max_tokens=900),
        settings,
    )
    raw = branch.output if branch.ok else {}
    operations = normalize_operations(raw, save_mode=save_mode)
    saved_ids: list[str] = []
    store = KnowledgeStore(user_id)
    for operation in operations[:3]:
        if operation["action"] == "ignore":
            continue
        source_type = "user" if save_mode == "explicit" else "conversation"
        source_ref = f"conversation:{session_id}" if session_id else "conversation:reflection"
        entry = build_entry(user_id, {
            "title": operation["title"], "content": operation["content"],
            "topic": operation["topic"], "keywords": operation["keywords"],
            "description": operation.get("description", ""), "source_type": source_type,
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
        saved_ids.append(entry.id)
    # 返回保存的条目 id 列表：调用方据此发文档级 RagIndexUpdated（PRD-RAG-9）。
    return saved_ids


__all__ = [
    "build_append_request", "candidate_request", "load_prompt",
    "normalize_operations", "reflect_if_candidate",
]
