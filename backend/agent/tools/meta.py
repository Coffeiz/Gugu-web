"""meta 工具集：use_skill —— 渐进式披露的入口。

system prompt 里只放「可用技能」索引（每个一行 name + 何时用）；模型判断相关时调
use_skill(name) 把该技能的正文（剧本）拉进上下文，再照着执行（可能再调 http_get 等 tool）。

依赖单向：tools（本模块）→ skills（加载器）。
"""
from __future__ import annotations

from agent import skills as _skills
from agent.tools.base import BaseSkill, Tool


async def _use_skill(db, user_id, args: dict):
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "缺少技能名"}
    body = _skills.load_skill(name)
    if body is None:
        avail = "、".join(s["slug"] for s in _skills.skills_index())
        return {"error": f"没有名为「{name}」的技能", "available": avail}
    return {"skill": name, "content": body}


class MetaSkill(BaseSkill):
    name = "meta"
    tools = [
        Tool(
            name="use_skill",
            label="调用技能",
            description="按名称拉取一个「技能」的详细做法说明（剧本），拿到后照它执行。"
                        "可用技能清单见系统提示里的「可用技能」。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "技能标识或名字，如 weather / 天气查询"},
                },
                "required": ["name"],
            },
            handler=_use_skill,
        ),
    ]


MetaSkill().register()
