"""用户 Prompt Skill 管理 API。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent.capabilities.defaults import all_system_tool_names
from agent.capabilities.errors import CapabilityRegistrationError
from agent.capabilities.models import CapabilityMeta
from agent.capabilities.skill_registry import SkillCapabilityRegistry
from agent.capabilities.tool_registry import ToolCapabilityRegistry
from agent.tools import registry as tool_registry
from agent.tools.base import Tool
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
    return all_system_tool_names()


def _builtin_skill_tools() -> tuple[list[dict[str, str | bool]], set[str]]:
    names = _allowed_tools()
    metadata = ToolCapabilityRegistry(tool_registry).metadata(names)
    items = [
        {"name": item.name, "description_short": item.description_short,
         "category": item.category, "enabled": item.enabled}
        for item in metadata
    ]
    return items, {item.name for item in metadata}


async def _available_skill_tools(
    user_id: object,
    *,
    discover_mcp: bool = True,
) -> tuple[list[dict[str, str | bool]], set[str], list[Tool]]:
    """返回本用户当前可关联的内置与 MCP 工具，不缓存跨开关状态。"""
    builtin_items, builtin_names = _builtin_skill_tools()
    dynamic_tools = []
    from app.core.config import get_settings

    if discover_mcp and get_settings().mcp.enabled:
        from agent.mcp.manager import mcp_manager

        dynamic_tools = await mcp_manager.list_user_tools(user_id)

    dynamic = [
        CapabilityMeta(
            name=tool.name,
            kind="tool",
            description_short=(tool.description_short or tool.label or tool.name)[:100],
            category=tool.category or "mcp",
            source="mcp",
            enabled=True,
        )
        for tool in dynamic_tools
        if tool.name not in builtin_names
    ]
    dynamic_items = [
        {"name": item.name, "description_short": item.description_short,
         "category": item.category, "enabled": item.enabled}
        for item in dynamic
    ]
    return [*builtin_items, *dynamic_items], builtin_names | {
        item.name for item in dynamic
    }, dynamic_tools


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
async def list_skills(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    include_tools: bool = Query(default=True),
):
    rows = (await db.execute(select(UserSkill).where(
        UserSkill.owner_id == current_user.id,
    ).order_by(UserSkill.updated_at.desc(), UserSkill.id.desc()))).scalars().all()
    if include_tools:
        tools, _, _ = await _available_skill_tools(current_user.id)
    else:
        # 技能目录首屏不应因为用户配置的远程 MCP server 响应慢而阻塞。
        tools = []
    return {
        "skills": [_serialize(row) for row in rows],
        "tools": tools,
    }


@router.get("/tools")
async def list_skill_tools(current_user: User = Depends(get_current_user)):
    """按需加载技能关联工具；MCP 工具发现只在用户展开工具选择器时触发。"""
    tools, _, _ = await _available_skill_tools(current_user.id)
    return {"tools": tools}


@router.post("", status_code=201)
async def create_skill(payload: UserSkillPayload, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        needs_mcp_discovery = any(name.startswith("mcp_") for name in payload.related_tools)
        _, allowed_tool_names, dynamic_tools = await _available_skill_tools(
            current_user.id, discover_mcp=needs_mcp_discovery,
        )
        row = await _registry.create_user_skill(
            db, current_user.id, allowed_tool_names=allowed_tool_names,
            dynamic_tools=dynamic_tools,
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
        existing = (await db.execute(select(UserSkill).where(
            UserSkill.owner_id == current_user.id,
            UserSkill.slug == slug,
        ))).scalar_one_or_none()
        retained_tools = set(existing.related_tools or ()) if existing else set()
        requested_tools = payload.related_tools or []
        needs_mcp_discovery = any(
            name.startswith("mcp_") and name not in retained_tools
            for name in requested_tools
        )
        _, allowed_tool_names, dynamic_tools = await _available_skill_tools(
            current_user.id, discover_mcp=needs_mcp_discovery,
        )
        row = await _registry.update_user_skill(
            db, current_user.id, slug, allowed_tool_names=allowed_tool_names,
            dynamic_tools=dynamic_tools,
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
