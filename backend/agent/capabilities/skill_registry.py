"""Markdown Skill 的 Capability adapter。"""

from __future__ import annotations

import hashlib
from sqlalchemy import select, update

from agent import skills
from agent.security.logsafe import fingerprint
from .errors import CapabilityRegistrationError
from .models import CapabilityMeta, DESCRIPTION_SHORT_MAX_CHARS


_MAX_BODY_CHARS = 20_000
_ALLOWED_CATEGORIES = {"personal", "productivity", "research", "creative", "other"}


def _digest(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


def _validate_manager(value: str | None) -> str:
    manager = str(value or "user").strip().lower()
    if manager not in {"user", "assistant"}:
        raise CapabilityRegistrationError("Skill 管理者必须是 user 或 assistant")
    return manager


def serialize_user_skill_metadata(items: tuple[CapabilityMeta, ...] | list[CapabilityMeta]) -> list[dict]:
    """把会话要冻结的用户 Skill 元数据转成可持久化的 JSON 形状。"""
    return [
        {
            "name": item.name,
            "display_name": item.display_name,
            "kind": item.kind,
            "description_short": item.description_short,
            "category": item.category,
            "permissions": list(item.permissions),
            "platforms": list(item.platforms),
            "related_tools": list(item.related_tools),
            "related_skills": list(item.related_skills),
            "source": item.source,
            "enabled": bool(item.enabled),
            "content_digest": item.content_digest,
            "owner_fingerprint": item.owner_fingerprint,
        }
        for item in items
        if item.kind == "skill" and item.source == "user"
    ]


def deserialize_user_skill_metadata(value) -> tuple[CapabilityMeta, ...] | None:
    """读取会话内冻结的用户 Skill 元数据；格式异常时返回 None 触发一次重建。"""
    if not isinstance(value, list):
        return None
    items = []
    for row in value:
        if not isinstance(row, dict) or row.get("kind") != "skill" or row.get("source") != "user":
            return None
        name = str(row.get("name") or "").strip()
        display_name = str(row.get("display_name") or "").strip()
        description = str(row.get("description_short") or "").strip()
        if not name or not display_name or not description:
            return None
        items.append(CapabilityMeta(
            name=name,
            kind="skill",
            description_short=description,
            display_name=display_name,
            category=str(row.get("category") or ""),
            permissions=tuple(str(item) for item in (row.get("permissions") or ()) if str(item)),
            platforms=tuple(str(item) for item in (row.get("platforms") or ()) if str(item)),
            related_tools=tuple(str(item) for item in (row.get("related_tools") or ()) if str(item)),
            related_skills=tuple(str(item) for item in (row.get("related_skills") or ()) if str(item)),
            source="user",
            enabled=bool(row.get("enabled", True)),
            content_digest=str(row.get("content_digest") or ""),
            owner_fingerprint=str(row.get("owner_fingerprint") or ""),
        ))
    return tuple(items)


def validate_user_skill(*, name: str, description_short: str,
                        description_long: str | None, category: str,
                        related_tools: list[str] | tuple[str, ...], body: str,
                        owner_id: object) -> dict:
    """校验并规范化用户 Skill；数据库和未来创建入口共用此协议。"""
    if owner_id is None:
        raise CapabilityRegistrationError("用户 Skill 缺少 owner_id")
    values = {
        "name": str(name or "").strip(),
        "description_short": str(description_short or "").strip(),
        "description_long": str(description_long or "").strip() or None,
        "category": str(category or "personal").strip().lower(),
        "body": str(body or "").strip(),
    }
    if not 1 <= len(values["name"]) <= 120:
        raise CapabilityRegistrationError("Skill 名称长度必须是 1-120 个字符")
    if not 1 <= len(values["description_short"]) <= DESCRIPTION_SHORT_MAX_CHARS:
        raise CapabilityRegistrationError(
            f"Skill 短描述长度必须是 1-{DESCRIPTION_SHORT_MAX_CHARS} 个字符"
        )
    if values["description_long"] and len(values["description_long"]) > 500:
        raise CapabilityRegistrationError("Skill 长描述最多 500 个字符")
    if values["category"] not in _ALLOWED_CATEGORIES:
        raise CapabilityRegistrationError("Skill 分类不受支持")
    if not values["body"] or len(values["body"]) > _MAX_BODY_CHARS:
        raise CapabilityRegistrationError("Skill 正文不能为空且最多 20000 个字符")
    tools = tuple(dict.fromkeys(str(item).strip() for item in (related_tools or ()) if str(item).strip()))
    if len(tools) > 32:
        raise CapabilityRegistrationError("Skill 最多关联 32 个工具")
    return {**values, "related_tools": list(tools), "source": "user",
            "enabled": True, "content_digest": _digest(values["body"])}


class SkillCapabilityRegistry:
    def metadata(self, names: list[str] | None = None) -> tuple[CapabilityMeta, ...]:
        rows = skills.skill_metadata(None if names is None else list(names))
        out = []
        for row in rows:
            short = (row.get("description_short") or "").strip()
            if not short:
                short = (row.get("name") or row["id"]).strip()
            if not short or len(short) > 100:
                raise CapabilityRegistrationError(
                    f"Skill {row['id']} 的短描述必须是 1-100 个字符"
                )
            out.append(CapabilityMeta(
                name=row["id"], kind="skill", description_short=short,
                display_name=row["name"],
                category=row.get("category", ""),
                related_tools=tuple(row.get("related_tools", ()) or ()),
                source=row.get("source", "builtin") or "builtin",
                enabled=True,
            ))
        return tuple(out)

    def diagnostics(self, names: list[str] | None = None) -> tuple[str, ...]:
        return skills.skill_diagnostics(names)

    async def user_metadata(self, db, owner_id: object, *, enabled_only: bool = True) -> tuple[CapabilityMeta, ...]:
        """读取当前用户自己的 Skill metadata；不返回正文。"""
        from app.models import UserSkill

        query = select(UserSkill).where(UserSkill.owner_id == owner_id)
        if enabled_only:
            query = query.where(UserSkill.enabled.is_(True))
        rows = (await db.execute(query.order_by(UserSkill.id))).scalars().all()
        return tuple(
            CapabilityMeta(
                name=row.skill_id,
                kind="skill",
                description_short=row.description_short,
                display_name=row.name,
                category=row.category,
                related_tools=tuple(row.related_tools or ()),
                source="user",
                enabled=bool(row.enabled),
                content_digest=row.content_digest or "",
                owner_fingerprint=fingerprint(str(owner_id)),
            )
            for row in rows
            if row.source == "user"
        )

    async def load_user_skill(self, db, owner_id: object, skill_id: str):
        """按 owner 加载启用中的用户 Skill 正文；不允许跨用户或停用 Skill。"""
        from app.models import UserSkill

        value = str(skill_id or "").strip().upper()
        if not value.startswith("U") or not value[1:].isdigit():
            return None
        return (await db.execute(select(UserSkill).where(
            UserSkill.owner_id == owner_id,
            UserSkill.skill_id == value,
            UserSkill.enabled.is_(True),
            UserSkill.source == "user",
        ))).scalar_one_or_none()

    async def create_user_skill(self, db, owner_id: object, *, dynamic_tools=(),
                                **payload):
        """创建用户 Skill；关联工具只作引用校验，不授予执行权限。"""
        from app.models import UserSkill
        from agent.tools import registry as tool_registry

        managed_by = _validate_manager(payload.pop("managed_by", "user"))
        values = validate_user_skill(owner_id=owner_id, **payload)
        values["managed_by"] = managed_by
        tool_snapshot = tool_registry.snapshot()
        dynamic_names = {tool.name for tool in dynamic_tools}
        missing = [name for name in values["related_tools"]
                   if tool_snapshot.get(name) is None and name not in dynamic_names
                   and not name.startswith("mcp_")]
        if missing:
            raise CapabilityRegistrationError(f"Skill 关联了未知工具：{', '.join(missing)}")
        from app.models import User
        next_value = await db.scalar(
            update(User).where(User.id == owner_id)
            .values(next_skill_sequence=User.next_skill_sequence + 1)
            .returning(User.next_skill_sequence)
        )
        if next_value is None:
            raise CapabilityRegistrationError("当前用户不存在，无法分配 Skill ID")
        row = UserSkill(owner_id=owner_id, skill_id=f"U{int(next_value) - 1}", **values)
        db.add(row)
        await db.flush()
        return row

    async def update_user_skill(self, db, owner_id: object, skill_id: str, *, dynamic_tools=(),
                                enabled: bool | None = None, **payload):
        """按 ID 更新当前用户 Skill；正文变化时重新计算 digest。"""
        from app.models import UserSkill
        row = (await db.execute(select(UserSkill).where(
            UserSkill.owner_id == owner_id, UserSkill.skill_id == skill_id,
        ))).scalar_one_or_none()
        if row is None:
            return None
        values = {
            "name": payload.get("name", row.name),
            "description_short": payload.get("description_short", row.description_short),
            "description_long": payload.get("description_long", row.description_long),
            "category": payload.get("category", row.category),
            "related_tools": payload.get("related_tools", row.related_tools or ()),
            "body": payload.get("body", row.body),
        }
        managed_by = _validate_manager(payload.get("managed_by", row.managed_by or "user"))
        normalized = validate_user_skill(owner_id=owner_id, **values)
        normalized["managed_by"] = managed_by
        from agent.tools import registry as tool_registry
        tool_snapshot = tool_registry.snapshot()
        dynamic_names = {tool.name for tool in dynamic_tools}
        missing = [name for name in normalized["related_tools"]
                   if tool_snapshot.get(name) is None
                   and name not in dynamic_names
                   and not name.startswith("mcp_")]
        if missing:
            raise CapabilityRegistrationError(f"Skill 关联了未知工具：{', '.join(missing)}")
        for key in ("name", "description_short", "description_long", "category",
                    "related_tools", "body", "content_digest", "managed_by"):
            setattr(row, key, normalized[key])
        if enabled is not None:
            row.enabled = bool(enabled)
        await db.flush()
        return row

    async def delete_user_skill(self, db, owner_id: object, skill_id: str) -> bool:
        """删除当前用户 Skill；系统 Skill 不经过此入口。"""
        from app.models import UserSkill
        row = (await db.execute(select(UserSkill).where(
            UserSkill.owner_id == owner_id, UserSkill.skill_id == skill_id,
        ))).scalar_one_or_none()
        if row is None:
            return False
        await db.delete(row)
        await db.flush()
        return True
