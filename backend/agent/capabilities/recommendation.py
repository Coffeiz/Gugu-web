"""Capability RAG 的运行时软推荐。"""

from __future__ import annotations

import hashlib
import json
import logging
import time

from agent.rag.index_cache import search_documents_with_cache
from agent.rag.models import IndexDocument, Scope

from .models import CapabilitySnapshot, SelectedCapabilities

_log = logging.getLogger("agent.capabilities.recommendation")


def _snapshot_digest(snapshot: CapabilitySnapshot) -> str:
    values = [(name, item.description_short, item.category, item.content_digest)
              for name, item in snapshot.tools.items()]
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()[:24]


def _documents(snapshot: CapabilitySnapshot, owner_id: object) -> list[IndexDocument]:
    revision = _snapshot_digest(snapshot)
    scope = Scope(owner_user_id=str(owner_id or "capability-catalog"), scope_type="capability")
    return [IndexDocument(
        document_id=f"capability:{name}", source_type="capability", source_id=name,
        scope=scope, title=name, summary=item.description_short,
        content=" ".join((name, item.description_short, item.category, " ".join(item.related_skills))),
        version=revision, metadata={"capability_name": name},
    ) for name, item in snapshot.tools.items() if item.enabled]


async def recommend(query: str, snapshot: CapabilitySnapshot, *, owner_id: object,
                    limit: int = 5, shadow: bool = True) -> SelectedCapabilities:
    """查询统一 RAG 并返回软推荐；失败时保持完整授权目录。"""
    authorized = tuple(snapshot.tools)
    if not (query or "").strip() or not authorized:
        return SelectedCapabilities(authorized, shadow=shadow)
    diagnostics: dict[str, object] = {"namespace": "capability", "source_type": "capability"}
    started = time.monotonic()
    try:
        results = await search_documents_with_cache(
            owner_id, _documents(snapshot, owner_id), query,
            limit=max(1, min(int(limit), 20)), source_types=("capability",), diagnostics=diagnostics,
        )
        recommended: list[str] = []
        reasons: dict[str, str] = {}
        scores: dict[str, float] = {}
        allowed = set(authorized)
        for result in results:
            document = getattr(result, "document", None)
            metadata = getattr(document, "metadata", {}) or {}
            name = str(metadata.get("capability_name") or getattr(document, "source_id", ""))
            if name not in allowed or name in recommended:
                continue
            recommended.append(name)
            scores[name] = float(getattr(result, "score", 0.0) or 0.0)
            reasons[name] = "能力目录 RAG 相关"
        recommended_set = set(recommended)
        ranked = tuple(recommended) + tuple(name for name in authorized if name not in recommended_set)
        ordered = authorized if shadow else ranked
        diagnostics.update({"recommended_count": len(recommended), "authorized_count": len(authorized),
                            "latency_ms": int((time.monotonic() - started) * 1000), "shadow": shadow})
        _log.info(json.dumps(diagnostics, ensure_ascii=False, separators=(",", ":")))
        return SelectedCapabilities(ordered, reasons=reasons, scores=scores, shadow=shadow)
    except Exception as exc:
        _log.warning("能力目录 RAG 推荐跳过：%s", type(exc).__name__)
        return SelectedCapabilities(authorized, shadow=True)
