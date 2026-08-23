"""meta 工具集：use_skill —— 渐进式披露的入口。

system prompt 里只放「可用技能」索引（每个一行 name + 何时用）；模型判断相关时调
use_skill(name) 把该技能的正文（剧本）拉进上下文，再照着执行（可能再调 http_get 等 tool）。

依赖单向：tools（本模块）→ skills（加载器）。
"""
from __future__ import annotations

import json

from agent import skills as _skills
from agent.tools.base import BaseSkill, Tool


async def _use_skill(db, user_id, args: dict):
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "缺少技能名"}
    slug = _skills.resolve_skill_slug(name)
    body = _skills.load_skill(name)
    if body is None:
        avail = "、".join(s["slug"] for s in _skills.skills_index())
        return {"error": f"没有名为「{name}」的技能", "available": avail}
    return {
        "skill": slug or name,
        "content": body,
        "_capability_usage": {"kind": "skill", "slug": slug or name, "loaded": True},
    }


async def _ask_user(db, user_id, args: dict):
    """返回受控交互描述；Prompt/Action 由 Agent Loop 绑定 session 后创建。"""
    return {
        "_interaction": "ask_user",
        "kind": args.get("kind", "choice"),
        "title": args.get("title", "需要你的选择"),
        "body": args.get("body", ""),
        "options": args.get("options", []),
        "allow_text_input": bool(args.get("allow_text_input", False)),
    }


async def _call_tool(db, user_id, args: dict):
    """固定 Adapter Tool 的非 Agent Loop 调用入口。

    主循环会在这里之前执行一次自己的 UI/确认编排；直接 dispatch 时保留同一套
    registry、权限与 Schema 校验，避免 Adapter 形成第二套执行器。
    """
    name = str(args.get("name") or "").strip()
    arguments = args.get("arguments")
    if not name:
        return {"error": "缺少业务工具名"}
    if not isinstance(arguments, dict):
        return {"error": "arguments 必须是 object"}
    from agent.tools import registry
    result, _artifact = await registry.dispatch(user_id, name, arguments)
    try:
        return json.loads(result) if isinstance(result, str) else result
    except (TypeError, ValueError):
        return {"result": result}


class MetaSkill(BaseSkill):
    name = "meta"
    tools = [
        Tool(
            name="call_tool",
            label="调用工具",
            description="固定工具适配入口。根据工具目录调用一个已授权业务工具。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": 80},
                    "arguments": {"type": "object"},
                },
                "required": ["name", "arguments"],
                "additionalProperties": False,
            },
            handler=_call_tool,
        ),
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
        Tool(
            name="ask_user",
            label="询问用户",
            description=(
                "当下一步存在多个合理选择，或缺少继续任务所必需的信息时，向用户展示结构化问题。"
                "只用于澄清，不直接执行任何业务操作；明确的破坏性确认必须使用工具自己的确认门。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["choice", "question", "form"]},
                    "title": {"type": "string", "maxLength": 120},
                    "body": {"type": "string", "maxLength": 1000},
                    "options": {
                        "type": "array",
                        "minItems": 0,
                        "maxItems": 8,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "id": {"type": "string", "minLength": 1, "maxLength": 64},
                                "label": {"type": "string", "minLength": 1, "maxLength": 120},
                            },
                            "required": ["id", "label"],
                        },
                    },
                    "allow_text_input": {"type": "boolean"},
                },
                "required": ["kind", "title", "body", "options"],
                "additionalProperties": False,
            },
            handler=_ask_user,
        ),
    ]


MetaSkill().register()
