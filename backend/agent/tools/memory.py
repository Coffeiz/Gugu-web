"""记忆技能：让咕咕能主动"记住"用户的长期信息。

remember 把一条画像写进结构化 .agent/profile.json（与反思共用 store.apply_profile_ops 去重/印证）。
用户明确让记的东西通常就是"这个人是谁"（身份/偏好/习惯），profile 不带 kind/conf、不衰减，
跟"用户明确说了、该永久记住"这个语义天然匹配——不需要反思那套观察/推断的置信度机制。
handler 不需要 db（记忆走文件），但保持 (db, user_id, args) 统一签名。
"""
import json

from agent.memory import store
from agent.tools.base import BaseSkill, Tool


async def _remember(db, user_id, args: dict):
    text = (args.get("text") or "").strip()
    if not text:
        return json.dumps({"error": "需要提供要记住的内容 text"})
    profile = await store.read_profile_list(user_id)
    profile = store.apply_profile_ops(profile, [text], [])
    await store.write_profile_list(user_id, profile)
    from agent import events
    events.publish(events.types.MemoryUpdated(user_id=user_id, added=1, removed=0, source="remember"))
    return {"success": True, "remembered": text}


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
                    "text": {"type": "string", "description": "要记住的一句话稳定画像或偏好"},
                },
                "required": ["text"],
            },
            handler=_remember,
        ),
    ]


MemorySkill().register()
