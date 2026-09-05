"""meta 工具集：工具声明、调用与技能加载的固定入口。

system prompt 里只放「可用技能」索引（每个一行 name + 何时用）；模型判断相关时调
use_skill(name) 把该技能的正文（剧本）拉进上下文，再照着执行（可能再调 http_get 等 tool）。

依赖单向：tools（本模块）→ skills（加载器）。
"""
from __future__ import annotations

import json
from agent import skills as _skills
from agent.security.logsafe import fingerprint
from agent.tools.base import BaseSkill, Tool
from agent.tools.skill_management import SKILL_MANAGEMENT_TOOLS
from agent.tools.tool_contract import normalize_tool_name


async def _get_tool_schema(db, user_id, args: dict):
    """获取本轮需要的业务工具 Schema；只读，不执行任何业务操作。"""
    from agent.im import imctx
    from agent.im.permissions import can_use_tool
    from agent.tools import registry
    from agent.tools.base import current_dispatch_tool_snapshot

    requested = args.get("tools")
    if not isinstance(requested, list) or not requested:
        return {"error": "tools 必须是非空数组"}
    current_im = imctx.get_im()
    allowed = current_im.get("allowed_tool_names") if current_im else None
    declared: list[str] = []
    rejected: list[str] = []
    tool_snapshot = current_dispatch_tool_snapshot() or registry.snapshot()
    for raw_name in requested[:12]:
        name = str(raw_name or "").strip()
        if not name or name in declared:
            continue
        if tool_snapshot.get(name) is None or not can_use_tool(name, allowed):
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
    from agent.tools.base import current_dispatch_skill_state
    loaded_state = current_dispatch_skill_state()
    if (
        isinstance(content_digest, str)
        and content_digest
        and loaded_state is not None
        and loaded_state.get(slug or name) == content_digest
    ):
        return {
            "skill": slug or name,
            "already_loaded": True,
            "message": "该技能正文已在当前上下文中，无需重复加载。",
        }
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
    if args.get("authorization") == "user_sandbox":
        from app.services.filesystem_authorization import filesystem_authorization_enabled

        if not filesystem_authorization_enabled():
            return {"error": "完整用户沙箱授权功能当前未开启"}
        # 授权交互不能由模型自定义按钮语义，避免把普通澄清误当作权限授予。
        return {
            "_interaction": "ask_user",
            "kind": "choice",
            "title": "确认授权完整用户沙箱权限？",
            "body": (
                "授权后，当前会话中的 Shell 可读写完整用户沙箱内的 workspace、personal 和 project。"
                "这不会授予宿主机、其他用户目录或 Docker 权限；可使用 /workspace revoke 撤销。"
            ),
            "options": [
                {"id": "confirm", "label": "确认授权"},
                {"id": "cancel", "label": "取消"},
            ],
            "authorization": "user_sandbox",
            "allow_text_input": False,
        }
    return {
        "_interaction": "ask_user",
        "kind": args.get("kind", "choice"),
        "title": args.get("title", "需要你的选择"),
        "body": args.get("body", ""),
        "options": args.get("options", []),
        # ask_user 是咕咕主动发起的澄清交互，选择卡统一附带自定义回答入口；
        # 系统确认卡不经过此工具，不能获得该能力。
        "allow_text_input": True,
    }


async def _call_tool(db, user_id, args: dict):
    """固定 Adapter Tool 的非 Agent Loop 调用入口。

    主循环会在这里之前执行一次自己的 UI/确认编排；直接 dispatch 时保留同一套
    registry、权限与 Schema 校验，避免 Adapter 形成第二套执行器。
    """
    name = normalize_tool_name(args.get("name"))
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
            description="适配入口：根据已获取的目标工具 Schema 调用一个已授权业务工具。arguments 必须是原生 JSON object，数组、布尔值和数字保持原生类型。",
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
            description_short='读取技能正文；name 传技能标识或名字，拿到后按步骤执行',
            description="按名称拉取一个「技能」的详细做法说明（剧本），拿到后照它执行。"
                        "可用技能清单见系统提示里的「可用技能」。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                },
                "required": ["name"],
            },
            handler=_use_skill,
        ),
        *SKILL_MANAGEMENT_TOOLS,
        Tool(
            name="ask_user",
            label="询问用户",
            description_short='向用户展示选项或澄清问题；不执行业务操作',
            description=(
                "当下一步存在多个合理选择，或缺少继续任务所必需的信息时，向用户展示结构化问题。"
                "choice 选择卡会自动附带“自定义回复”，用户可在原聊天输入框补充回答。"
                "只用于澄清，不直接执行普通业务操作；权限、删除、覆盖等破坏性确认必须使用工具自己的确认门。"
                "如确需申请当前会话的完整用户沙箱读写权限，使用 authorization=user_sandbox；系统会展示固定授权范围和确认按钮。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["choice", "question", "form"]},
                    "title": {"type": "string", "maxLength": 120},
                    "body": {"type": "string", "maxLength": 1000},
                    "authorization": {"type": "string", "enum": ["user_sandbox"]},
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
                },
                "required": ["kind", "title", "body", "options"],
                "additionalProperties": False,
            },
            handler=_ask_user,
        ),
    ]


MetaSkill().register()
