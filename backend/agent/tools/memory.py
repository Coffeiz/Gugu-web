"""记忆技能：让咕咕能主动"记住"用户的长期信息。

remember 把一条事实写进结构化 .agent/facts.json（与反思共用 store.apply_facts_ops 去重/印证）。
用户明确让记 → kind=observed（亲述、确凿、不衰减）、importance 给高（4）。
handler 不需要 db（记忆走文件），但保持 (db, user_id, args) 统一签名。
"""
import json

from agent.memory import store
from agent.tools.base import BaseSkill, Tool


async def _remember(db, user_id, args: dict):
    fact = (args.get("fact") or "").strip()
    if not fact:
        return json.dumps({"error": "需要提供要记住的内容 fact"})
    facts = await store.read_facts_list(user_id)
    facts = store.apply_facts_ops(facts, [{"text": fact, "kind": "observed", "importance": 4}], [])
    await store.write_facts_list(user_id, facts)
    from agent import events
    events.publish(events.types.MemoryUpdated(user_id=user_id, added=1, removed=0, source="remember"))
    return {"success": True, "remembered": fact}


class MemorySkill(BaseSkill):
    name = "memory"
    tools = [
        Tool(
            name="remember", label="记住",
            description=(
                "把一条关于用户的长期信息记进记忆（如偏好、习惯、身份、在意的事）。"
                "用户明确说'记住X'、或你了解到值得长期记住的稳定信息时调用。"
                "只记稳定信息，不记一次性琐事。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "fact": {"type": "string", "description": "要记住的一句话事实"},
                },
                "required": ["fact"],
            },
            handler=_remember,
        ),
    ]


MemorySkill().register()
