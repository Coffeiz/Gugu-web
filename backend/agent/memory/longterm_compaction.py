"""profile/pattern 达到水位后的长期记忆整理。"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from agent.context.provider_runner import complete_json
from agent.llm.modelctx import effective_ai, get_usage_context, usage_context_scope
from agent.memory import store

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"
COMPACTION_THRESHOLD = 100
COMPACTION_TARGET = 70
_logger = logging.getLogger("agent.memory.longterm_compaction")


def _prompt(name: str) -> str:
    return (_PROMPTS_DIR / name).read_text(encoding="utf-8").strip()


def _memory_input(items: list[dict]) -> str:
    return "\n".join(f"[{index}] {json.dumps(item, ensure_ascii=False)}" for index, item in enumerate(items))


async def _complete_maintenance(
    user_id, prompt: str, items: list[dict], settings, *, correction: str | None = None,
) -> dict:
    """将自动画像和行为整理归入压缩，保留同用户的触发会话。"""
    parent = get_usage_context()
    session_id = parent.session_id if parent is not None and parent.user_id == user_id else None
    with usage_context_scope(user_id, session_id, scenario="compaction"):
        output_limit = getattr(effective_ai(settings), "max_tokens", None) if settings is not None else None
        system_prompt = _prompt(prompt)
        if correction:
            # 仅传递校验码与位置，不回显模型原始输出或任何记忆正文。
            system_prompt += (
                "\n\n上一轮结果未通过结构校验。请重新基于输入生成完整结果，"
                f"修正项：{correction}。严格遵循本提示中的 JSON schema 和数量限制，"
                "只输出 JSON，不要解释。"
            )
        return await complete_json(
            system_prompt, _memory_input(items), settings,
            max_tokens=output_limit,
        )


def _pattern_strength(item: dict) -> tuple[int, float, int, float]:
    return (
        1 if item.get("kind") == "observed" else 0,
        float(item.get("conf", 0.0) or 0.0),
        int(item.get("importance", item.get("imp", 0)) or 0),
        float(item.get("ts", 0.0) or 0.0),
    )


def _check_profile(value) -> tuple[list[dict] | None, str, int | None, int | None]:
    if not isinstance(value, list):
        return None, "profile_result_not_array", None, None
    if not value:
        return None, "profile_result_empty", None, 0
    if len(value) > COMPACTION_TARGET:
        return None, "profile_count_over_target", None, len(value)
    result = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            return None, "profile_item_not_object", index, len(value)
        if not str(item.get("text") or "").strip():
            return None, "profile_text_missing", index, len(value)
        item_type = str(item.get("type") or "note")
        if item_type not in store.PROFILE_TYPES:
            return None, "profile_type_invalid", index, len(value)
        result.append({"type": item_type, "text": str(item["text"]).strip(), "ts": item.get("ts")})
    return result, "", None, len(value)


def _valid_profile(value) -> list[dict] | None:
    return _check_profile(value)[0]


def _check_pattern(value, source_items: list[dict]) -> tuple[list[dict] | None, str, int | None, int | None]:
    if not isinstance(value, list):
        return None, "pattern_result_not_array", None, None
    if not value:
        return None, "pattern_result_empty", None, 0
    if len(value) > COMPACTION_TARGET:
        return None, "pattern_count_over_target", None, len(value)
    source_ids = {str(item.get("id") or "") for item in source_items}
    seen_ids = set()
    result = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            return None, "pattern_item_not_object", index, len(value)
        if not str(item.get("text") or "").strip():
            return None, "pattern_text_missing", index, len(value)
        item_id = str(item.get("id") or "")
        if not item_id or item_id not in source_ids:
            return None, "pattern_source_id_invalid", index, len(value)
        if item_id in seen_ids:
            return None, "pattern_source_id_duplicate", index, len(value)
        seen_ids.add(item_id)
        kind = item.get("kind")
        if not isinstance(kind, str) or kind not in {"observed", "inferred"}:
            return None, "pattern_kind_invalid", index, len(value)
        try:
            conf = min(0.97, max(0.0, float(item.get("conf", 0.6))))
            importance = min(5, max(1, int(item.get("importance", item.get("imp", 3)))))
            ts = float(item.get("ts", 0.0) or 0.0)
        except (TypeError, ValueError):
            return None, "pattern_numeric_field_invalid", index, len(value)
        result.append({
            "id": str(item.get("id") or ""), "text": str(item["text"]).strip(),
            "kind": kind, "conf": conf, "imp": importance, "ts": ts,
        })
    return result, "", None, len(value)


def _valid_pattern(value, source_items: list[dict]) -> list[dict] | None:
    return _check_pattern(value, source_items)[0]


async def _complete_validated_maintenance(user_id, prompt, field, items, settings, checker):
    """输出结构不合法时允许一次定向修正；失败后保留原记忆并结束。"""
    result = await _complete_maintenance(user_id, prompt, items, settings)
    normalized, reason, index, output_count = checker(
        result.get(field) if isinstance(result, dict) else None,
    )
    if normalized is not None:
        return normalized

    _logger.warning(
        "长期记忆整理输出校验失败: kind=%s reason=%s attempt=1 item_index=%s output_count=%s",
        field, reason, index, output_count,
    )
    correction = f"reason={reason}, item_index={index if index is not None else 'none'}"
    result = await _complete_maintenance(
        user_id, prompt, items, settings, correction=correction,
    )
    normalized, reason, index, output_count = checker(
        result.get(field) if isinstance(result, dict) else None,
    )
    if normalized is None:
        _logger.warning(
            "长期记忆整理修正后仍未通过校验: kind=%s reason=%s attempt=2 item_index=%s output_count=%s",
            field, reason, index, output_count,
        )
    return normalized


async def compact_profile(user_id, settings) -> bool:
    items = await store.read_profile_list(user_id)
    if len(items) < COMPACTION_THRESHOLD:
        return False
    source_digest = store.profile_list_digest(items)
    profile = await _complete_validated_maintenance(
        user_id, "profile_compact.md", "profile", items, settings, _check_profile,
    )
    if profile is None:
        return False
    # LLM 调用期间可能有 reflection/memory tool 写入；摘要变化时放弃本轮，绝不回写旧快照。
    if not await store.write_profile_list_if_unchanged(user_id, source_digest, profile):
        return False
    from agent import events
    events.publish(events.types.MemoryUpdated(
        user_id=user_id, added=0, removed=max(0, len(items) - len(profile)), source="compaction-profile",
    ))
    return True


async def compact_pattern(user_id, settings) -> bool:
    items = await store.read_pattern_list(user_id)
    if len(items) < COMPACTION_THRESHOLD:
        return False
    source_digest = store.pattern_list_digest(items)
    patterns = await _complete_validated_maintenance(
        user_id, "pattern_compact.md", "pattern", items, settings,
        lambda value: _check_pattern(value, items),
    )
    if patterns is None:
        return False
    patterns.sort(key=_pattern_strength, reverse=True)
    compacted = patterns[:COMPACTION_TARGET]
    # LLM 调用期间可能有 reflection/memory tool 写入；摘要变化时放弃本轮，绝不回写旧快照。
    if not await store.write_pattern_list_if_unchanged(user_id, source_digest, compacted):
        return False
    await store.sync_pattern_vecs(user_id, compacted, force=True)
    from agent import events
    events.publish(events.types.MemoryUpdated(
        user_id=user_id, added=0, removed=max(0, len(items) - len(compacted)), source="compaction-pattern",
    ))
    return True
