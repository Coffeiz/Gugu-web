"""记忆技能：让咕咕能主动记住用户的画像或行事模式。

入口统一负责把用户输入路由到 profile/pattern，并交给 store 的规范化与去重管线，
避免工具直接拼出过时的 JSON 结构。
"""
import json

from agent.memory import store
from agent.tools.base import BaseSkill, Tool


async def _remember(db, user_id, args: dict):
    text = (args.get("text") or "").strip()
    if not text:
        return json.dumps({"error": "需要提供要记住的内容 text"})

    target = str(args.get("target") or "profile").strip().lower()
    if target not in {"profile", "pattern"}:
        return {"error": "target 只能是 profile 或 pattern"}

    if target == "profile":
        item_type = str(args.get("type") or "note").strip().lower()
        if item_type not in store.PROFILE_TYPES:
            return {"error": "profile type 不合法"}
        profile = await store.read_profile_list(user_id)
        profile = store.apply_profile_ops(profile, [{"type": item_type, "text": text}], [])
        await store.write_profile_list(user_id, profile)
    else:
        try:
            importance = int(args.get("importance", 3) or 3)
        except (TypeError, ValueError):
            return {"error": "pattern importance 必须是 1 到 5 的整数"}
        if not 1 <= importance <= 5:
            return {"error": "pattern importance 必须是 1 到 5 的整数"}
        patterns = await store.read_pattern_list(user_id)
        patterns = store.apply_pattern_ops(
            patterns,
            [{"text": text, "kind": "observed", "importance": importance}],
            [],
        )
        await store.write_pattern_list(user_id, patterns)
        await store.sync_pattern_vecs(user_id, patterns)

    from agent import events
    events.publish(events.types.MemoryUpdated(user_id=user_id, added=1, removed=0, source="remember"))
    return {"success": True, "target": target, "remembered": text}


class MemorySkill(BaseSkill):
    name = "memory"
    tools = [
        Tool(
            name="remember", label="记住",
            description=(
                "把一条关于用户的长期信息或行事模式记进记忆。默认写入 profile；"
                "用户明确说要记住做事/决策/协作方式时，使用 target=pattern。"
                "只记稳定信息，不记一次性琐事；工具会自动生成正确的 profile/pattern 结构并去重。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "要记住的一句话稳定画像或偏好"},
                    "target": {"type": "string", "enum": ["profile", "pattern"],
                               "description": "写入目标；默认 profile，行事/决策模式用 pattern"},
                    "type": {"type": "string", "enum": sorted(store.PROFILE_TYPES),
                             "description": "target=profile 时的画像类型，默认 note"},
                    "importance": {"type": "integer", "minimum": 1, "maximum": 5,
                                   "description": "target=pattern 时的重要度 1-5，默认 3"},
                },
                "required": ["text"],
            },
            handler=_remember,
            mutates=True,
        ),
    ]


MemorySkill().register()
