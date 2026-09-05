"""profile/pattern 达到水位后的长期记忆整理。"""
from __future__ import annotations

import json
from pathlib import Path

from agent.context.provider_runner import complete_json
from agent.memory import store

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"
COMPACTION_THRESHOLD = 100
COMPACTION_TARGET = 70


def _prompt(name: str) -> str:
    return (_PROMPTS_DIR / name).read_text(encoding="utf-8").strip()


def _memory_input(items: list[dict]) -> str:
    return "\n".join(f"[{index}] {json.dumps(item, ensure_ascii=False)}" for index, item in enumerate(items))


def _pattern_strength(item: dict) -> tuple[int, float, int, float]:
    return (
        1 if item.get("kind") == "observed" else 0,
        float(item.get("conf", 0.0) or 0.0),
        int(item.get("importance", item.get("imp", 0)) or 0),
        float(item.get("ts", 0.0) or 0.0),
    )


def _valid_profile(value) -> list[dict] | None:
    if not isinstance(value, list) or len(value) > COMPACTION_TARGET:
        return None
    result = []
    for item in value:
        if not isinstance(item, dict) or not str(item.get("text") or "").strip():
            return None
        item_type = str(item.get("type") or "note")
        if item_type not in store.PROFILE_TYPES:
            return None
        result.append({"type": item_type, "text": str(item["text"]).strip(), "ts": item.get("ts")})
    return result


def _valid_pattern(value, source_items: list[dict]) -> list[dict] | None:
    if not isinstance(value, list) or len(value) > COMPACTION_TARGET:
        return None
    source_ids = {str(item.get("id") or "") for item in source_items}
    seen_ids = set()
    result = []
    for item in value:
        if not isinstance(item, dict) or not str(item.get("text") or "").strip():
            return None
        item_id = str(item.get("id") or "")
        if not item_id or item_id not in source_ids or item_id in seen_ids:
            return None
        seen_ids.add(item_id)
        kind = item.get("kind")
        if kind not in {"observed", "inferred"}:
            return None
        try:
            conf = min(0.97, max(0.0, float(item.get("conf", 0.6))))
            importance = min(5, max(1, int(item.get("importance", item.get("imp", 3)))))
            ts = float(item.get("ts", 0.0) or 0.0)
        except (TypeError, ValueError):
            return None
        result.append({
            "id": str(item.get("id") or ""), "text": str(item["text"]).strip(),
            "kind": kind, "conf": conf, "imp": importance, "ts": ts,
        })
    return result


async def compact_profile(user_id, settings) -> bool:
    items = await store.read_profile_list(user_id)
    if len(items) < COMPACTION_THRESHOLD:
        return False
    result = await complete_json(_prompt("profile_compact.md"), _memory_input(items), settings, max_tokens=4000)
    if not isinstance(result, dict):
        return False
    profile = _valid_profile(result.get("profile"))
    if profile is None:
        return False
    await store.write_profile_list(user_id, profile)
    from agent import events
    events.publish(events.types.MemoryUpdated(
        user_id=user_id, added=0, removed=max(0, len(items) - len(profile)), source="compaction-profile",
    ))
    return True


async def compact_pattern(user_id, settings) -> bool:
    items = await store.read_pattern_list(user_id)
    if len(items) < COMPACTION_THRESHOLD:
        return False
    result = await complete_json(_prompt("pattern_compact.md"), _memory_input(items), settings, max_tokens=4000)
    if not isinstance(result, dict):
        return False
    patterns = _valid_pattern(result.get("pattern"), items)
    if patterns is None:
        return False
    patterns.sort(key=_pattern_strength, reverse=True)
    compacted = patterns[:COMPACTION_TARGET]
    await store.write_pattern_list(user_id, compacted)
    await store.sync_pattern_vecs(user_id, compacted, force=True)
    from agent import events
    events.publish(events.types.MemoryUpdated(
        user_id=user_id, added=0, removed=max(0, len(items) - len(compacted)), source="compaction-pattern",
    ))
    return True
