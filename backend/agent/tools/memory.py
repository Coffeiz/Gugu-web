"""记忆技能：让咕咕能主动"记住"用户的长期信息。

remember 把一条事实写进 .agent/facts.md（与反思共用 store.merge_facts 去重）。
handler 不需要 db（记忆走文件），但保持 (db, user_id, args) 统一签名。
"""
import json

from agent.memory import store
from agent.tools.base import BaseSkill, Tool


async def _remember(db, user_id, args: dict):
    fact = (args.get("fact") or "").strip()
    if not fact:
        return json.dumps({"error": "需要提供要记住的内容 fact"})
    mem = await store.read_memory(user_id)
    merged = store.merge_facts(mem["facts"], [fact])
    await store.write_facts(user_id, merged)
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
