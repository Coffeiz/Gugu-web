"""Prompt Skill 的查询，以及用户自定义 Skill 的创建、更新和删除工具。

本模块独立注册 Skill 管理工具；Skill 正文仍通过 ``meta.py`` 中的 ``use_skill`` 入口按需加载。
所有持久化操作都通过 ``SkillCapabilityRegistry``，不直接绕过注册服务写表。
"""
from __future__ import annotations

import hashlib
import json

from agent.tools.base import BaseSkill, Tool


async def _list_skills(db, user_id, args: dict):
    """列出内置技能和当前账号的用户 Skill 元数据，不返回正文。"""
    from agent import skills as builtin_skills
    from app.models import UserSkill
    from sqlalchemy import select

    if db is None or user_id is None:
        return {"error": "列出技能需要当前账号上下文"}

    rows = (await db.execute(
        select(UserSkill).where(
            UserSkill.owner_id == user_id,
            UserSkill.source == "user",
        ).order_by(UserSkill.name, UserSkill.slug)
    )).scalars().all()
    visible_skills = [
        {
            "slug": row["slug"],
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
            "slug": row.slug,
            "name": row.name,
            "description_short": row.description_short,
            "category": row.category,
            "related_tools": list(row.related_tools or ()),
            "enabled": bool(row.enabled),
            "source": "user",
        }
        for row in rows
    )
    visible_skills.sort(key=lambda item: (item["name"].casefold(), item["slug"]))
    return {
        "count": len(visible_skills),
        "skills": visible_skills,
    }


async def _create_skill(db, user_id, args: dict):
    """通过统一注册服务创建用户 Prompt Skill，不开放任何可执行代码。"""
    from agent.capabilities.skill_registry import SkillCapabilityRegistry
    from agent.im import imctx
    from agent.capabilities.defaults import all_system_tool_names
    from agent.tools import registry

    name = str(args.get("name") or "").strip()
    slug = str(args.get("slug") or "").strip().lower()
    if not slug:
        slug = f"user-skill-{hashlib.sha256(name.encode('utf-8')).hexdigest()[:10]}"
    current_im = imctx.get_im()
    allowed = current_im.get("allowed_tool_names") if current_im else None
    allowed = list(allowed) if allowed is not None else all_system_tool_names()
    related = [str(item).strip() for item in (args.get("related_tools") or ()) if str(item).strip()]
    tool_snapshot = registry.snapshot()
    missing = [item for item in related if tool_snapshot.get(item) is None]
    if missing:
        return {"error": f"Skill 关联了未知工具：{', '.join(missing)}"}
    unauthorized = [item for item in related if item not in set(allowed)]
    if unauthorized:
        return {"error": f"Skill 关联了当前不可用的工具：{', '.join(unauthorized)}"}
    body_digest = hashlib.sha256(json.dumps(
        {k: args.get(k) for k in ("name", "slug", "description_short", "description_long",
                                  "category", "related_tools", "body") if args.get(k) is not None},
        ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    from agent.security import confirm
    blocked = confirm.needs_confirmation(
        args, "创建一个新的用户自定义 Skill，并保存到当前账号", user_id,
        identity=f"create_user_skill:{slug or name}:{body_digest}",
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


async def _update_skill(db, user_id, args: dict):
    """更新当前用户的 Prompt Skill；slug 是稳定标识，不允许通过更新改名。"""
    from agent.capabilities.skill_registry import SkillCapabilityRegistry
    from agent.im import imctx
    from agent.capabilities.defaults import all_system_tool_names

    slug = str(args.get("slug") or "").strip().lower()
    if not slug:
        return {"error": "缺少技能 slug"}
    fields = {
        key: args[key]
        for key in (
            "name", "description_short", "description_long", "category",
            "related_tools", "body", "enabled",
        )
        if key in args
    }
    if not fields:
        return {"error": "至少提供一个要更新的字段"}
    current_im = imctx.get_im()
    allowed = current_im.get("allowed_tool_names") if current_im else None
    allowed = list(allowed) if allowed is not None else all_system_tool_names()
    try:
        row = await SkillCapabilityRegistry().update_user_skill(
            db, user_id, slug, allowed_tool_names=allowed, **fields,
        )
        if row is None:
            return {"error": "技能不存在或不属于当前用户"}
        await db.commit()
        return {
            "success": True,
            "skill": {
                "slug": row.slug,
                "name": row.name,
                "description_short": row.description_short,
                "related_tools": list(row.related_tools or ()),
                "enabled": bool(row.enabled),
                "content_digest": row.content_digest,
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
    """删除当前用户的 Prompt Skill；删除前必须通过统一确认门。"""
    from agent.capabilities.skill_registry import SkillCapabilityRegistry
    from agent.security import confirm
    from app.models import UserSkill
    from sqlalchemy import select

    slug = str(args.get("slug") or "").strip().lower()
    if not slug:
        return {"error": "缺少技能 slug"}
    row = (await db.execute(select(UserSkill).where(
        UserSkill.owner_id == user_id,
        UserSkill.slug == slug,
        UserSkill.source == "user",
    ))).scalar_one_or_none()
    if row is None:
        return {"error": "技能不存在或不属于当前用户"}
    blocked = confirm.needs_confirmation(
        args,
        f"将删除技能「{row.name}」（{row.slug}），此操作不可恢复",
        user_id,
        identity=f"delete_user_skill:slug={row.slug}",
    )
    if blocked:
        return blocked
    deleted = await SkillCapabilityRegistry().delete_user_skill(db, user_id, row.slug)
    if not deleted:
        return {"error": "技能不存在或不属于当前用户"}
    await db.commit()
    return {"success": True, "slug": row.slug, "message": "已删除这个咕咕技能。"}


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
        repeat_safe=True,
    ),
    Tool(
        name="create_skill",
        label="创建咕咕技能",
        description_short="创建用户自定义技能并保存可复用做法。",
        description=(
            "创建可复用的 Prompt Skill；不是项目，也不是调用已有技能。需要 name、description_short、body、related_tools；不能注册工具或扩大权限。"
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
            },
            "required": ["name", "description_short", "body", "related_tools"],
            "additionalProperties": False,
        },
        handler=_create_skill,
        mutates=True,
        requires_confirmation=True,
    ),
    Tool(
        name="update_skill",
        label="更新咕咕技能",
        description_short="更新已有咕咕技能；slug 保持不变",
        description=(
            "更新当前用户已有的 Prompt Skill。必须传稳定 slug，并至少传一个要修改的字段；"
            "不能修改 slug、注册工具或扩大权限，关联工具仍由工具注册表校验。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "slug": {"type": "string", "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$", "maxLength": 80},
                "name": {"type": "string", "minLength": 1, "maxLength": 120},
                "description_short": {"type": "string", "minLength": 1, "maxLength": 100},
                "description_long": {"type": ["string", "null"], "maxLength": 500},
                "category": {"type": "string", "enum": ["personal", "productivity", "research", "creative", "other"]},
                "related_tools": {"type": "array", "maxItems": 32, "items": {"type": "string", "maxLength": 80}},
                "body": {"type": "string", "minLength": 1, "maxLength": 20000},
                "enabled": {"type": "boolean"},
            },
            "required": ["slug"],
            "additionalProperties": False,
        },
        handler=_update_skill,
        mutates=True,
    ),
    Tool(
        name="delete_skill",
        label="删除咕咕技能",
        description_short="删除已有咕咕技能；执行前需要确认",
        description=(
            "删除当前用户已有的 Prompt Skill。首次调用会返回确认请求，"
            "用户确认后由服务端执行删除；系统 Skill 和其他用户的 Skill 不可删除。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "slug": {"type": "string", "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$", "maxLength": 80},
            },
            "required": ["slug"],
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
