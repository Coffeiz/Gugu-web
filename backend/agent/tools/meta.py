"""meta 工具集：工具声明、调用与技能加载的固定入口。

system prompt 里只放「可用技能」索引（每个一行 name + 何时用）；模型判断相关时调
use_skill(name) 把该技能的正文（剧本）拉进上下文，再照着执行（可能再调 http_get 等 tool）。

依赖单向：tools（本模块）→ skills（加载器）。
"""
from __future__ import annotations

import json
import hashlib

from agent import skills as _skills
from agent.security.logsafe import fingerprint
from agent.tools.base import BaseSkill, Tool


async def _get_tool_schema(db, user_id, args: dict):
    """获取本轮需要的业务工具 Schema；只读，不执行任何业务操作。"""
    from agent.im import imctx
    from agent.im.permissions import can_use_tool
    from agent.tools import registry

    requested = args.get("tools")
    if not isinstance(requested, list) or not requested:
        return {"error": "tools 必须是非空数组"}
    current_im = imctx.get_im()
    allowed = current_im.get("allowed_tool_names") if current_im else None
    declared: list[str] = []
    rejected: list[str] = []
    for raw_name in requested[:12]:
        name = str(raw_name or "").strip()
        if not name or name in declared:
            continue
        if registry.get(name) is None or not can_use_tool(name, allowed):
            rejected.append(name)
            continue
        declared.append(name)
    if not declared and rejected:
        return {"error": "没有可获取 Schema 的已授权工具", "rejected": rejected}
    return {"tool_schemas": declared, "rejected": rejected}


async def _use_skill(db, user_id, args: dict):
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "缺少技能名"}
    slug = _skills.resolve_skill_slug(name)
    body = _skills.load_skill(name)
    source = "builtin"
    owner_fingerprint = ""
    if body is None and db is not None and user_id is not None:
        from agent.capabilities.skill_registry import SkillCapabilityRegistry
        row = await SkillCapabilityRegistry().load_user_skill(db, user_id, name)
        if row is not None:
            slug = row.slug
            body = row.body
            content_digest = row.content_digest
            source = "user"
            owner_fingerprint = fingerprint(str(user_id))
    if body is None:
        avail = "、".join(s["slug"] for s in _skills.skills_index())
        return {"error": f"没有名为「{name}」的技能", "available": avail}
    content_digest = content_digest if source == "user" else _skills.skill_content_digest(slug or name)
    marker = {
        "kind": "skill", "slug": slug or name, "loaded": True,
        "content_digest": content_digest,
    }
    if source == "user":
        marker.update({"source": source, "owner_fingerprint": owner_fingerprint})
    return {
        "skill": slug or name,
        "content": body,
        "_capability_usage": marker,
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


async def _create_skill(db, user_id, args: dict):
    """通过统一注册服务创建用户 Prompt Skill，不开放任何可执行代码。"""
    from agent.capabilities.skill_registry import SkillCapabilityRegistry
    from agent.im import imctx
    from agent.profiles.default import DefaultProfile
    from agent.tools import registry

    name = str(args.get("name") or "").strip()
    slug = str(args.get("slug") or "").strip().lower()
    if not slug:
        slug = f"user-skill-{hashlib.sha256(name.encode('utf-8')).hexdigest()[:10]}"
    current_im = imctx.get_im()
    allowed = current_im.get("allowed_tool_names") if current_im else None
    allowed = list(allowed) if allowed is not None else DefaultProfile().tool_names
    related = [str(item).strip() for item in (args.get("related_tools") or ()) if str(item).strip()]
    risky = [item for item in related if (registry.get(item) and (registry.get(item).mutates or registry.get(item).destructive))]
    if risky:
        from agent.security import confirm
        blocked = confirm.needs_confirmation(
            args, f"创建会关联写入或危险工具的 Skill：{', '.join(risky)}", user_id,
        )
        if blocked:
            return blocked
    try:
        row = await SkillCapabilityRegistry().create_user_skill(
            db, user_id, allowed_tool_names=allowed,
            slug=slug, name=name,
            description_short=args.get("description_short") or "",
            description_long=args.get("description_long"),
            category=args.get("category") or "personal",
            related_tools=related, body=args.get("body") or "",
        )
        await db.commit()
        return {
            "success": True, "skill": {
                "slug": row.slug, "name": row.name,
                "description_short": row.description_short,
                "related_tools": list(row.related_tools or ()), "enabled": row.enabled,
            },
            "message": "已创建这个咕咕技能，后续会在需要时按需加载。",
        }
    except Exception as exc:
        await db.rollback()
        from agent.capabilities.errors import CapabilityRegistrationError
        if isinstance(exc, CapabilityRegistrationError):
            return {"error": str(exc)}
        raise


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
            description_short='按名称调用工具；arguments 保留 JSON 类型并匹配目标 Schema',
            description=("固定工具适配入口。根据已获取的目标工具 Schema 调用一个已授权业务工具。"
                         "arguments 必须是 JSON object，内部字段必须保留原生 JSON 类型：数组用 [..]，布尔值用 true/false（不要加引号），"
                         "数字不要写成字符串；不要把字段包装成 {\"item\": ...}。"),
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": 80},
                    "arguments": {"type": "object", "description": "目标工具参数；保留数组、布尔值和数字的 JSON 原生类型"},
                },
                "required": ["name", "arguments"],
                "additionalProperties": False,
            },
            handler=_call_tool,
        ),
        Tool(
            name="get_tool_schema",
            label="获取工具 Schema",
            description_short='获取工具完整 Schema；只读，不执行工具',
            description=(
                "获取本轮要使用的一个或多个已授权业务工具的完整参数 Schema。只读操作，不会执行工具。"
                "未在当前对话历史中出现过完整 Schema 的工具，必须先获取 Schema。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "tools": {
                        "type": "array", "minItems": 1, "maxItems": 12,
                        "items": {"type": "string", "minLength": 1, "maxLength": 80},
                    },
                },
                "required": ["tools"],
                "additionalProperties": False,
            },
            handler=_get_tool_schema,
        ),
        Tool(
            name="use_skill",
            label="调用技能",
            description_short='读取技能正文；拿到后按步骤执行',
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
            name="create_skill",
            label="创建咕咕技能",
            description_short='创建咕咕技能；关键字段 name',
            description=(
                "当用户明确要求记住一套可复用做法时，创建一个 Prompt Skill。"
                "只能保存指导文本，不能写代码、注册新工具或扩大权限。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "slug": {"type": "string", "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$", "maxLength": 80},
                    "name": {"type": "string", "minLength": 1, "maxLength": 120},
                    "description_short": {"type": "string", "minLength": 1, "maxLength": 100},
                    "description_long": {"type": "string", "maxLength": 500},
                    "category": {"type": "string", "enum": ["personal", "productivity", "research", "creative", "other"]},
                    "related_tools": {"type": "array", "maxItems": 32, "items": {"type": "string", "maxLength": 80}},
                    "body": {"type": "string", "minLength": 1, "maxLength": 20000},
                    "confirm": {"type": "boolean"},
                    "confirm_token": {"type": "string"},
                },
                "required": ["name", "description_short", "body", "related_tools"],
                "additionalProperties": False,
            },
            handler=_create_skill,
            mutates=True,
        ),
        Tool(
            name="ask_user",
            label="询问用户",
            description_short='向用户展示选项或澄清问题；不执行业务操作',
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
