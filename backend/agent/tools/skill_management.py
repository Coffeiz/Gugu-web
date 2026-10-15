"""Prompt Skill 的查询，以及用户自定义 Skill 的创建、更新和删除工具。

本模块独立注册 Skill 管理工具；Skill 正文仍通过 ``meta.py`` 中的 ``use_skill`` 入口按需加载。
所有持久化操作都通过 ``SkillCapabilityRegistry``，不直接绕过注册服务写表。
"""
from __future__ import annotations

from agent.tools.base import BaseSkill, Tool


def _skill_tool_context():
    """读取当前 Run 中可用于校验 MCP 引用的工具；不参与权限判定。"""
    from agent.tools.base import current_dispatch_tool_snapshot

    snapshot = current_dispatch_tool_snapshot()
    dynamic_tools = [
        tool for name in snapshot.all_tool_names()
        if (tool := snapshot.get(name)) is not None and tool.source == "mcp"
    ] if snapshot is not None else []
    return dynamic_tools


async def _list_skills(db, user_id, args: dict):
    """列出内置技能和当前账号的用户 Skill 元数据，不返回正文。"""
    from agent import skills as builtin_skills
    from app.services.mind import list_user_prompt_skills

    if db is None or user_id is None:
        return {"error": "列出技能需要当前账号上下文"}

    rows = await list_user_prompt_skills(db, user_id)
    visible_skills = [
        {
            "id": row["id"],
            "name": row["name"],
            "description_short": row["description_short"],
            "category": row.get("category", ""),
            "related_tools": list(row.get("related_tools") or ()),
            "enabled": True,
            "source": "builtin",
        }
        for row in builtin_skills.skill_metadata()
    ]
    visible_skills.extend(
        {
            "id": row.skill_id,
            "name": row.name,
            "description_short": row.description_short,
            "category": row.category,
            "related_tools": list(row.related_tools or ()),
            "managed_by": row.managed_by or "user",
            "enabled": bool(row.enabled),
            "source": "user",
        }
        for row in rows
    )
    visible_skills.sort(key=lambda item: (item["name"].casefold(), item["id"]))
    return {
        "count": len(visible_skills),
        "skills": visible_skills,
    }


async def _create_skill(db, user_id, args: dict):
    """通过统一注册服务创建用户 Prompt Skill，不开放任何可执行代码。"""
    from agent.capabilities.skill_registry import SkillCapabilityRegistry
    from agent.tools import registry

    name = str(args.get("skill_name") or "").strip()
    dynamic_tools = _skill_tool_context()
    related = [str(item).strip() for item in (args.get("related_tools") or ()) if str(item).strip()]
    tool_snapshot = registry.snapshot()
    dynamic_names = {tool.name for tool in dynamic_tools}
    missing = [item for item in related
               if tool_snapshot.get(item) is None and item not in dynamic_names
               and not item.startswith("mcp_")]
    if missing:
        return {"error": f"Skill 关联了未知工具：{', '.join(missing)}"}
    managed_by = str(args.get("managed_by") or "user").strip().lower()
    if managed_by not in {"user", "assistant"}:
        return {"error": "Skill 管理者必须是 user 或 assistant"}
    try:
        row = await SkillCapabilityRegistry().create_user_skill(
            db, user_id, name=name,
            description_short=args.get("description_short") or "",
            description_long=args.get("description_long"),
            category=args.get("category") or "personal",
            related_tools=related, body=args.get("body") or "", managed_by=managed_by,
            dynamic_tools=dynamic_tools,
        )
        await db.commit()
        return {
            "success": True, "skill": {
                "id": row.skill_id, "name": row.name,
                "description_short": row.description_short,
                "related_tools": list(row.related_tools or ()), "enabled": row.enabled,
                "managed_by": row.managed_by,
            },
            "message": "已创建这个咕咕技能，后续会在需要时按需加载。",
        }
    except Exception as exc:
        await db.rollback()
        from agent.capabilities.errors import CapabilityRegistrationError
        if isinstance(exc, CapabilityRegistrationError):
            return {"error": str(exc)}
        raise


async def _update_skill(db, user_id, args: dict):
    """按 ID 更新当前用户的 Prompt Skill；名称可以修改，ID 保持不变。"""
    from agent.capabilities.skill_registry import SkillCapabilityRegistry

    skill_id = str(args.get("id") or "").strip().upper()
    if not skill_id:
        return {"error": "缺少 Skill ID"}
    fields = {
        key: args[key]
        for key in (
            "skill_name", "description_short", "description_long", "category",
            "related_tools", "body", "enabled",
        )
        if key in args
    }
    if not fields:
        return {"error": "至少提供一个要更新的字段"}
    if "skill_name" in fields:
        fields["name"] = fields.pop("skill_name")
    dynamic_tools = _skill_tool_context()
    try:
        row = await SkillCapabilityRegistry().update_user_skill(
            db, user_id, skill_id, dynamic_tools=dynamic_tools, **fields,
        )
        if row is None:
            return {"error": "技能不存在或不属于当前用户"}
        await db.commit()
        return {
            "success": True,
            "skill": {
                "id": row.skill_id,
                "name": row.name,
                "description_short": row.description_short,
                "related_tools": list(row.related_tools or ()),
                "enabled": bool(row.enabled),
                "content_digest": row.content_digest,
                "managed_by": row.managed_by or "user",
            },
            "message": "已更新这个咕咕技能。",
        }
    except Exception as exc:
        await db.rollback()
        from agent.capabilities.errors import CapabilityRegistrationError
        if isinstance(exc, CapabilityRegistrationError):
            return {"error": str(exc)}
        raise


async def _delete_skill(db, user_id, args: dict):
    """用户管理的 Skill 需要确认；咕咕管理的 Skill 可自主清理。"""
    from agent.capabilities.skill_registry import SkillCapabilityRegistry
    from agent.security import confirm
    from app.services.mind import get_user_prompt_skill

    skill_id = str(args.get("id") or "").strip().upper()
    if not skill_id:
        return {"error": "缺少 Skill ID"}
    row = await get_user_prompt_skill(db, user_id, skill_id)
    if row is None:
        return {"error": "技能不存在或不属于当前用户"}
    managed_by = row.managed_by or "user"
    if managed_by != "assistant":
        blocked = confirm.needs_confirmation(
            args,
            f"将删除技能「{row.name}」（{row.skill_id}），此操作不可恢复",
            user_id,
            purpose=confirm.ACTION,
            identity=f"delete_user_skill:id={row.skill_id}",
        )
        if blocked:
            return blocked
    deleted = await SkillCapabilityRegistry().delete_user_skill(db, user_id, row.skill_id)
    if not deleted:
        return {"error": "技能不存在或不属于当前用户"}
    await db.commit()
    result = {"success": True, "id": row.skill_id, "message": "已删除这个咕咕技能。"}
    if managed_by == "assistant":
        result["_confirm_gate_authorized"] = "confirmation_gate"
    return result


SKILL_MANAGEMENT_TOOLS = [
    Tool(
        name="list_skills",
        label="列出咕咕技能",
        description_short="列出内置及当前账号自定义技能和启用状态。",
        description=(
            "列出内置 Prompt Skill 和当前账号自定义 Prompt Skill，包含名称、用途、分类、关联工具、启用状态和来源；"
            "不会返回技能正文，也不会展示其他账号的技能。"
        ),
        input_schema={
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        handler=_list_skills,
    ),
    Tool(
        name="create_skill",
        label="创建咕咕技能",
        description_short="创建用户自定义技能并保存可复用做法。",
        description=(
            "创建可复用的 Prompt Skill；不是项目，也不是调用已有技能。需要 skill_name、description_short、body、related_tools 和 managed_by；"
            "明确按用户要求创建时 managed_by=user，从稳定重复流程中自主提炼时 managed_by=assistant。不能注册工具或扩大权限。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "skill_name": {"type": "string", "minLength": 1, "maxLength": 120},
                "description_short": {"type": "string", "minLength": 1, "maxLength": 100},
                "description_long": {"type": "string", "maxLength": 500},
                "category": {"type": "string", "enum": ["personal", "productivity", "research", "creative", "other"]},
                "related_tools": {"type": "array", "maxItems": 32, "items": {"type": "string", "maxLength": 80}},
                "body": {"type": "string", "minLength": 1, "maxLength": 20000},
                "managed_by": {"type": "string", "enum": ["user", "assistant"]},
            },
            "required": ["skill_name", "description_short", "body", "related_tools", "managed_by"],
            "additionalProperties": False,
        },
        handler=_create_skill,
        mutates=True,
    ),
    Tool(
        name="update_skill",
        label="更新咕咕技能",
        description_short="按稳定 Skill ID 更新技能名称或内容",
        description=(
            "更新当前用户已有的 Prompt Skill。必须传稳定 Skill ID，并至少传一个要修改的字段；"
            "只能自主更新 managed_by=assistant 的 Skill；managed_by=user 仅在用户明确要求修改时更新。"
            "可以修改展示名称，但不能修改 ID、注册工具或扩大权限；关联工具只表示引用，不授予调用权限。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "id": {"type": "string", "pattern": "^U[1-9][0-9]*$"},
                "skill_name": {"type": "string", "minLength": 1, "maxLength": 120},
                "description_short": {"type": "string", "minLength": 1, "maxLength": 100},
                "description_long": {"type": ["string", "null"], "maxLength": 500},
                "category": {"type": "string", "enum": ["personal", "productivity", "research", "creative", "other"]},
                "related_tools": {"type": "array", "maxItems": 32, "items": {"type": "string", "maxLength": 80}},
                "body": {"type": "string", "minLength": 1, "maxLength": 20000},
                "enabled": {"type": "boolean"},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
        handler=_update_skill,
        mutates=True,
    ),
    Tool(
        name="delete_skill",
        label="删除咕咕技能",
        description_short="删除咕咕技能；用户管理的技能需确认",
        description=(
            "删除当前用户已有的 Prompt Skill。managed_by=user 时必须先获得用户确认；managed_by=assistant 可自主删除已过时或重复的条目。"
            "系统 Skill 和其他用户的 Skill 不可删除。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "id": {"type": "string", "pattern": "^U[1-9][0-9]*$"},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
        handler=_delete_skill,
        mutates=True,
        destructive=True,
    ),
]


class SkillManagementSkill(BaseSkill):
    """Skill 管理工具的独立注册组。

    该组只负责让固定 Adapter 能在用户需要时发现并 dispatch 工具；不加入默认
    工具集合，因此这些工具不会作为常驻 Provider Schema 发送。
    """

    name = "skill-management"
    tools = SKILL_MANAGEMENT_TOOLS


SkillManagementSkill().register()
