"""用户 Prompt Skill 的创建、更新和删除工具。

本模块只负责 Skill 生命周期管理；Skill 加载和固定 Adapter 仍由 ``meta.py`` 负责。
所有持久化操作都通过 ``SkillCapabilityRegistry``，不直接绕过注册服务写表。
"""
from __future__ import annotations

import hashlib
import json

from agent.tools.base import Tool


async def _create_skill(db, user_id, args: dict):
    """通过统一注册服务创建用户 Prompt Skill，不开放任何可执行代码。"""
    from agent.capabilities.skill_registry import SkillCapabilityRegistry
    from agent.im import imctx
    from agent.profiles.default import DefaultProfile
    from agent.tools import registry
    tool_snapshot = registry.snapshot()

    name = str(args.get("name") or "").strip()
    slug = str(args.get("slug") or "").strip().lower()
    if not slug:
        slug = f"user-skill-{hashlib.sha256(name.encode('utf-8')).hexdigest()[:10]}"
    current_im = imctx.get_im()
    allowed = current_im.get("allowed_tool_names") if current_im else None
    allowed = list(allowed) if allowed is not None else DefaultProfile().tool_names
    related = [str(item).strip() for item in (args.get("related_tools") or ()) if str(item).strip()]
    risky = sorted(item for item in related if (
        tool_snapshot.get(item)
        and (tool_snapshot.get(item).mutates or tool_snapshot.get(item).destructive)
    ))
    if risky:
        body_digest = hashlib.sha256(json.dumps(
            {k: args.get(k) for k in ("name", "slug", "description_short", "description_long",
                                      "category", "related_tools") if args.get(k) is not None},
            ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]
        from agent.security import confirm
        blocked = confirm.needs_confirmation(
            args, f"创建会关联写入或危险工具的 Skill：{', '.join(risky)}", user_id,
            identity=f"create_user_skill:{slug or name}:{body_digest}:risky_tools={risky}",
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
    from agent.profiles.default import DefaultProfile

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
    allowed = list(allowed) if allowed is not None else DefaultProfile().tool_names
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
            "用户确认后重新调用同一 slug 才会删除；系统 Skill 和其他用户的 Skill 不可删除。"
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
