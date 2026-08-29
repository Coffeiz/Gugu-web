"""用户 Prompt Skill 管理 API。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent.capabilities.errors import CapabilityRegistrationError
from agent.capabilities.skill_registry import SkillCapabilityRegistry
from agent.profiles.default import DefaultProfile
from agent.capabilities.tool_registry import ToolCapabilityRegistry
from agent.tools import registry as tool_registry
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User, UserSkill


router = APIRouter(prefix="/skills", tags=["skills"])
_registry = SkillCapabilityRegistry()


class UserSkillPayload(BaseModel):
    slug: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=120)
    description_short: str = Field(min_length=1, max_length=100)
    description_long: str | None = Field(default=None, max_length=500)
    category: str = Field(default="personal", max_length=32)
    related_tools: list[str] = Field(default_factory=list, max_length=32)
    body: str = Field(min_length=1, max_length=20_000)
    enabled: bool = True


class UserSkillPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description_short: str | None = Field(default=None, min_length=1, max_length=100)
    description_long: str | None = Field(default=None, max_length=500)
    category: str | None = Field(default=None, max_length=32)
    related_tools: list[str] | None = Field(default=None, max_length=32)
    body: str | None = Field(default=None, min_length=1, max_length=20_000)
    enabled: bool | None = None


def _allowed_tools() -> list[str]:
    return DefaultProfile().tool_names


def _serialize(row: UserSkill) -> dict:
    return {
        "id": row.id, "slug": row.slug, "name": row.name,
        "description_short": row.description_short,
        "description_long": row.description_long,
        "category": row.category, "related_tools": list(row.related_tools or ()),
        "body": row.body,
        "source": row.source, "enabled": bool(row.enabled),
        "content_digest": row.content_digest,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.get("")
async def list_skills(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(UserSkill).where(
        UserSkill.owner_id == current_user.id,
    ).order_by(UserSkill.updated_at.desc(), UserSkill.id.desc()))).scalars().all()
    tools = ToolCapabilityRegistry(tool_registry).metadata(list(_allowed_tools()))
    return {
        "skills": [_serialize(row) for row in rows],
        "tools": [
            {"name": item.name, "description_short": item.description_short,
             "category": item.category, "enabled": item.enabled}
            for item in tools
        ],
    }


@router.post("", status_code=201)
async def create_skill(payload: UserSkillPayload, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        row = await _registry.create_user_skill(
            db, current_user.id, allowed_tool_names=_allowed_tools(),
            **payload.model_dump(exclude={"enabled"}),
        )
        row.enabled = payload.enabled
        await db.commit()
        await db.refresh(row)
        return _serialize(row)
    except CapabilityRegistrationError as exc:
        await db.rollback()
        raise HTTPException(422, str(exc)) from exc


@router.patch("/{slug}")
async def update_skill(slug: str, payload: UserSkillPatch, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        row = await _registry.update_user_skill(
            db, current_user.id, slug, allowed_tool_names=_allowed_tools(),
            **payload.model_dump(exclude_unset=True),
        )
        if row is None:
            raise HTTPException(404, "Skill 不存在")
        await db.commit()
        await db.refresh(row)
        return _serialize(row)
    except CapabilityRegistrationError as exc:
        await db.rollback()
        raise HTTPException(422, str(exc)) from exc


@router.delete("/{slug}", status_code=204)
async def delete_skill(slug: str, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    deleted = await _registry.delete_user_skill(db, current_user.id, slug)
    if not deleted:
        raise HTTPException(404, "Skill 不存在")
    await db.commit()
