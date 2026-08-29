"""Markdown Skill 的 Capability adapter。"""

from __future__ import annotations

import hashlib
import re

from sqlalchemy import select

from agent import skills
from agent.security.logsafe import fingerprint
from .errors import CapabilityRegistrationError
from .models import CapabilityMeta, DESCRIPTION_SHORT_MAX_CHARS


_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_MAX_BODY_CHARS = 20_000
_ALLOWED_CATEGORIES = {"personal", "productivity", "research", "creative", "other"}


def _digest(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


def validate_user_skill(*, slug: str, name: str, description_short: str,
                        description_long: str | None, category: str,
                        related_tools: list[str] | tuple[str, ...], body: str,
                        owner_id: object) -> dict:
    """校验并规范化用户 Skill；数据库和未来创建入口共用此协议。"""
    if owner_id is None:
        raise CapabilityRegistrationError("用户 Skill 缺少 owner_id")
    values = {
        "slug": str(slug or "").strip().lower(),
        "name": str(name or "").strip(),
        "description_short": str(description_short or "").strip(),
        "description_long": str(description_long or "").strip() or None,
        "category": str(category or "personal").strip().lower(),
        "body": str(body or "").strip(),
    }
    if not _SLUG_RE.fullmatch(values["slug"]) or len(values["slug"]) > 80:
        raise CapabilityRegistrationError("Skill slug 必须是小写字母、数字和连字符")
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
    builtin_rows = skills.skill_metadata()
    builtin_slugs = {row["slug"] for row in builtin_rows}
    builtin_names = {str(row.get("name") or "").strip().casefold() for row in builtin_rows}
    if values["slug"] in builtin_slugs or values["name"].casefold() in builtin_names:
        raise CapabilityRegistrationError("用户 Skill 不能覆盖系统 Skill")
    return {**values, "related_tools": list(tools), "source": "user",
            "enabled": True, "content_digest": _digest(values["body"])}


class SkillCapabilityRegistry:
    def metadata(self, names: list[str] | None = None) -> tuple[CapabilityMeta, ...]:
        rows = skills.skill_metadata(None if names is None else list(names))
        out = []
        for row in rows:
            short = (row.get("description_short") or "").strip()
            if not short:
                short = (row.get("name") or row["slug"]).strip()
            if not short or len(short) > 100:
                raise CapabilityRegistrationError(
                    f"Skill {row['slug']} 的短描述必须是 1-100 个字符"
                )
            out.append(CapabilityMeta(
                name=row["slug"], kind="skill", description_short=short,
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
        builtin_slugs = {row["slug"] for row in skills.skill_metadata()}
        return tuple(
            CapabilityMeta(
                name=row.slug,
                kind="skill",
                description_short=row.description_short,
                category=row.category,
                related_tools=tuple(row.related_tools or ()),
                source="user",
                enabled=bool(row.enabled),
                content_digest=row.content_digest or "",
                owner_fingerprint=fingerprint(str(owner_id)),
            )
            for row in rows
            if row.source == "user" and row.slug not in builtin_slugs
        )

    async def load_user_skill(self, db, owner_id: object, name: str):
        """按 owner 加载启用中的用户 Skill 正文；不允许跨用户或停用 Skill。"""
        from app.models import UserSkill

        value = str(name or "").strip().lower()
        if not value:
            return None
        return (await db.execute(select(UserSkill).where(
            UserSkill.owner_id == owner_id,
            UserSkill.slug == value,
            UserSkill.enabled.is_(True),
            UserSkill.source == "user",
        ))).scalar_one_or_none()

    async def create_user_skill(self, db, owner_id: object, *,
                                allowed_tool_names: set[str] | list[str] | tuple[str, ...],
                                **payload):
        """创建用户 Skill；所有入口必须经过这里，不允许直接写表。"""
        from app.models import UserSkill
        from agent.tools import registry as tool_registry

        values = validate_user_skill(owner_id=owner_id, **payload)
        missing = [name for name in values["related_tools"] if tool_registry.get(name) is None]
        if missing:
            raise CapabilityRegistrationError(f"Skill 关联了未知工具：{', '.join(missing)}")
        unauthorized = [name for name in values["related_tools"] if name not in set(allowed_tool_names)]
        if unauthorized:
            raise CapabilityRegistrationError(f"Skill 关联了当前不可用的工具：{', '.join(unauthorized)}")
        exists = await db.scalar(select(UserSkill.id).where(
            UserSkill.owner_id == owner_id, UserSkill.slug == values["slug"],
        ))
        if exists is not None:
            raise CapabilityRegistrationError("该用户已存在同 slug 的 Skill")
        row = UserSkill(owner_id=owner_id, **values)
        db.add(row)
        await db.flush()
        return row

    async def update_user_skill(self, db, owner_id: object, slug: str, *,
                                allowed_tool_names: set[str] | list[str] | tuple[str, ...],
                                enabled: bool | None = None, **payload):
        """更新当前用户 Skill；slug 不变，正文变化时重新计算 digest。"""
        from app.models import UserSkill
        row = (await db.execute(select(UserSkill).where(
            UserSkill.owner_id == owner_id, UserSkill.slug == slug,
        ))).scalar_one_or_none()
        if row is None:
            return None
        values = {
            "slug": row.slug, "name": payload.get("name", row.name),
            "description_short": payload.get("description_short", row.description_short),
            "description_long": payload.get("description_long", row.description_long),
            "category": payload.get("category", row.category),
            "related_tools": payload.get("related_tools", row.related_tools or ()),
            "body": payload.get("body", row.body),
        }
        normalized = validate_user_skill(owner_id=owner_id, **values)
        from agent.tools import registry as tool_registry
        missing = [name for name in normalized["related_tools"] if tool_registry.get(name) is None]
        if missing:
            raise CapabilityRegistrationError(f"Skill 关联了未知工具：{', '.join(missing)}")
        unauthorized = [name for name in normalized["related_tools"] if name not in set(allowed_tool_names)]
        if unauthorized:
            raise CapabilityRegistrationError(f"Skill 关联了当前不可用的工具：{', '.join(unauthorized)}")
        for key in ("name", "description_short", "description_long", "category",
                    "related_tools", "body", "content_digest"):
            setattr(row, key, normalized[key])
        if enabled is not None:
            row.enabled = bool(enabled)
        await db.flush()
        return row

    async def delete_user_skill(self, db, owner_id: object, slug: str) -> bool:
        """删除当前用户 Skill；系统 Skill 不经过此入口。"""
        from app.models import UserSkill
        row = (await db.execute(select(UserSkill).where(
            UserSkill.owner_id == owner_id, UserSkill.slug == slug,
        ))).scalar_one_or_none()
        if row is None:
            return False
        await db.delete(row)
        await db.flush()
        return True
