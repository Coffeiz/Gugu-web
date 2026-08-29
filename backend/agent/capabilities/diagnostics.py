"""能力注入的脱敏诊断数据。"""

from __future__ import annotations

import hashlib
import json

from .injector import catalog_block


def capability_injection_diagnostics(context) -> dict:
    """只返回数量、大小和 digest，不记录用户消息或完整 Schema。"""
    if context is None:
        return {}
    snapshot = context.snapshot
    selection = context.selection
    recommendation = getattr(context, "recommendation_selection", selection)
    catalog = catalog_block(snapshot)
    names = list(selection.tool_names)
    name_digest = hashlib.sha256(
        json.dumps(names, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:16]
    skill_names = list(context.snapshot.skills)
    skill_digest = hashlib.sha256(
        json.dumps(skill_names, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:16]
    return {
        "snapshot_generation": snapshot.generation,
        "catalog_count": len(snapshot.catalog),
        "catalog_chars": len(catalog),
        "authorized_tool_count": len(snapshot.tools),
        "selected_tool_count": len(names),
        "selected_tool_names": names,
        "selected_tool_digest": name_digest,
        "skill_count": len(skill_names),
        "skill_names": skill_names,
        "skill_digest": skill_digest,
        "skill_sources": {
            name: {
                "source": meta.source,
                "content_digest": meta.content_digest,
                "owner_fingerprint": meta.owner_fingerprint,
            }
            for name, meta in context.snapshot.skills.items()
        },
        "shadow": bool(selection.shadow),
        "recommendation_enabled": bool(getattr(context, "recommendation_enabled", False)),
        "recommendation_count": len(recommendation.reasons),
        "recommended_tool_digest": hashlib.sha256(
            json.dumps(list(recommendation.tool_names), ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()[:16],
        "recommendation_digest": hashlib.sha256(
            json.dumps(list(recommendation.reasons), ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()[:16],
        "diagnostic_count": len(snapshot.diagnostics),
    }
