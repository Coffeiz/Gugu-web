from __future__ import annotations

import pytest
from sqlalchemy import select

from agent.capabilities.errors import CapabilityRegistrationError
from agent.capabilities.index import CapabilityIndex
from agent.capabilities.skill_registry import SkillCapabilityRegistry, validate_user_skill
from agent.tools import registry as tool_registry
from agent.tools.skill_management import _create_skill, _list_skills
from agent.tools.meta import _use_skill
from agent.interactions.confirmations import confirmation_payload, redeem_confirmation
from app.models import UserSkill


def _payload(**overrides):
    value = {
        "slug": "morning-briefing",
        "name": "晨间简报",
        "description_short": "整理当天值得关注的事项",
        "description_long": "按用户习惯整理简短的晨间信息。",
        "category": "personal",
        "related_tools": ["http_get"],
        "body": "先收集公开信息，再按日期和优先级整理。",
    }
    value.update(overrides)
    return value


def test_user_skill_validator_normalizes_and_hashes(user_a):
    value = validate_user_skill(owner_id=user_a.id, **_payload())
    assert value["source"] == "user"
    assert value["enabled"] is True
    assert len(value["content_digest"]) == 16
    assert value["related_tools"] == ["http_get"]


@pytest.mark.parametrize("field,value", [
    ("slug", "Weather Routine"),
    ("description_short", ""),
    ("category", "admin"),
    ("body", ""),
])
def test_user_skill_validator_rejects_invalid_fields(user_a, field, value):
    with pytest.raises(CapabilityRegistrationError):
        validate_user_skill(owner_id=user_a.id, **_payload(**{field: value}))


@pytest.mark.asyncio
async def test_user_skill_is_owned_and_only_enabled_metadata_is_exposed(db, user_a, user_b):
    registry = SkillCapabilityRegistry()
    allowed = set(tool_registry._tools)
    await registry.create_user_skill(db, user_a.id, allowed_tool_names=allowed, **_payload())
    await registry.create_user_skill(
        db, user_b.id, allowed_tool_names=allowed,
        **_payload(slug="other-briefing", name="另一份简报"),
    )
    hidden = await registry.create_user_skill(
        db, user_a.id, allowed_tool_names=allowed,
        **_payload(slug="disabled-briefing", name="停用简报"),
    )
    hidden.enabled = False
    await db.commit()

    visible = await registry.user_metadata(db, user_a.id)
    assert [item.name for item in visible] == ["morning-briefing"]
    assert not any(item.name == "other-briefing" for item in visible)


@pytest.mark.asyncio
async def test_list_skills_returns_only_current_users_metadata_without_bodies(db, user_a, user_b):
    registry = SkillCapabilityRegistry()
    allowed = set(tool_registry._tools)
    disabled = await registry.create_user_skill(
        db, user_a.id, allowed_tool_names=allowed, **_payload(name="停用简报"),
    )
    await registry.create_user_skill(
        db, user_b.id, allowed_tool_names=allowed,
        **_payload(slug="private-briefing", name="其他用户的简报"),
    )
    disabled.enabled = False
    await registry.create_user_skill(
        db, user_a.id, allowed_tool_names=allowed,
        **_payload(slug="weekly-review", name="每周复盘"),
    )
    await db.commit()

    result = await _list_skills(db, user_a.id, {})

    from agent import skills as builtin_skills

    assert result["count"] == len(builtin_skills.skill_metadata()) + 2
    listed = {row["slug"]: row for row in result["skills"]}
    assert {"morning-briefing", "weekly-review"} <= listed.keys()
    assert "weather" in listed
    assert listed["weather"]["source"] == "builtin"
    assert not any(row["slug"] == "private-briefing" for row in result["skills"])
    assert all("body" not in row for row in result["skills"])
    assert all("content_digest" not in row for row in result["skills"])
    assert listed["morning-briefing"]["enabled"] is False
    assert listed["morning-briefing"]["source"] == "user"


@pytest.mark.asyncio
async def test_list_skills_requires_account_context():
    assert await _list_skills(None, None, {}) == {"error": "列出技能需要当前账号上下文"}


@pytest.mark.asyncio
async def test_user_skill_rejects_unknown_tool_and_duplicate_slug(db, user_a):
    registry = SkillCapabilityRegistry()
    allowed = set(tool_registry._tools)
    with pytest.raises(CapabilityRegistrationError, match="未知工具"):
        await registry.create_user_skill(
            db, user_a.id, allowed_tool_names=allowed,
            **_payload(related_tools=["does-not-exist"]),
        )
    with pytest.raises(CapabilityRegistrationError, match="不可用"):
        await registry.create_user_skill(
            db, user_a.id, allowed_tool_names=set(), **_payload(),
        )
    await registry.create_user_skill(db, user_a.id, allowed_tool_names=allowed, **_payload())
    with pytest.raises(CapabilityRegistrationError, match="同 slug"):
        await registry.create_user_skill(
            db, user_a.id, allowed_tool_names=allowed, **_payload(name="另一个晨报"),
        )


@pytest.mark.asyncio
async def test_user_skill_is_merged_into_user_capability_index(db, user_a):
    await SkillCapabilityRegistry().create_user_skill(
        db, user_a.id, allowed_tool_names=set(tool_registry._tools), **_payload(),
    )
    index = await CapabilityIndex.from_registries_for_user(db, user_a.id)
    assert "morning-briefing" in index._skills
    assert index._skills["morning-briefing"].source == "user"
    assert index._skills["morning-briefing"].content_digest
    assert index._skills["morning-briefing"].owner_fingerprint

    restricted = await CapabilityIndex.from_registries_for_user(db, user_a.id, tool_names=[])
    assert "morning-briefing" in restricted._skills
    assert restricted._skills["morning-briefing"].related_tools == ()


@pytest.mark.asyncio
async def test_use_skill_loads_owned_body_and_refreshes_digest(db, user_a):
    registry = SkillCapabilityRegistry()
    row = await registry.create_user_skill(
        db, user_a.id, allowed_tool_names=set(tool_registry._tools), **_payload(),
    )
    first = await _use_skill(db, user_a.id, {"name": row.slug})
    assert first["content"] == row.body
    assert first["_capability_usage"]["source"] == "user"
    assert first["_capability_usage"]["owner_fingerprint"]
    first_digest = first["_capability_usage"]["content_digest"]

    from agent.tools.base import reset_dispatch_session, set_dispatch_session
    loaded_state = {row.slug: first_digest}
    dispatch_token = set_dispatch_session(
        None, skill_state=loaded_state,
    )
    try:
        already_loaded = await _use_skill(db, user_a.id, {"name": row.slug})
    finally:
        reset_dispatch_session(dispatch_token)
    assert already_loaded["already_loaded"] is True

    row = await registry.update_user_skill(
        db, user_a.id, row.slug, allowed_tool_names=set(tool_registry._tools),
        body="更新后的用户 Skill 正文。",
    )
    dispatch_token = set_dispatch_session(
        None, skill_state=loaded_state,
    )
    try:
        second = await _use_skill(db, user_a.id, {"name": row.slug})
    finally:
        reset_dispatch_session(dispatch_token)
    assert second["content"] == "更新后的用户 Skill 正文。"
    assert second["_capability_usage"]["content_digest"] != first_digest

    row.enabled = False
    await db.flush()
    disabled = await _use_skill(db, user_a.id, {"name": row.slug})
    assert "error" in disabled


@pytest.mark.asyncio
async def test_create_skill_adapter_uses_registry_and_returns_structured_result(db, user_a):
    args = {
        "name": "夜间复盘",
        "description_short": "把当天事项整理成复盘清单",
        "related_tools": [],
        "body": "按完成、阻塞和下一步三个部分输出。",
    }
    blocked = await _create_skill(db, user_a.id, args)
    payload = confirmation_payload(blocked)
    assert payload is not None
    assert redeem_confirmation(user_a.id, payload["confirm_code"]) == 5
    result = await _create_skill(db, user_a.id, args)
    assert result["success"] is True
    assert result["skill"]["slug"].startswith("user-skill-")


@pytest.mark.asyncio
async def test_create_skill_requires_confirmation_before_persisting(db, user_a):
    """创建 Skill 必须先进入统一确认门，不能只因关联工具是只读工具就直接落库。"""
    args = {
        "name": "带确认的复盘",
        "description_short": "保存复盘方法",
        "related_tools": ["http_get"],
        "body": "先收集资料，再整理结论。",
    }
    blocked = await _create_skill(db, user_a.id, args)
    payload = confirmation_payload(blocked)
    assert payload is not None
    assert payload["status"] == "waiting_confirmation"
    assert payload["confirm_code"]
    assert await db.scalar(select(UserSkill).where(UserSkill.owner_id == user_a.id)) is None

    assert redeem_confirmation(user_a.id, payload["confirm_code"]) == 5
    created = await _create_skill(db, user_a.id, args)
    assert created["success"] is True


@pytest.mark.asyncio
async def test_create_skill_adapter_rejects_unavailable_tool(db, user_a):
    result = await _create_skill(db, user_a.id, {
        "name": "受限技能",
        "description_short": "不应关联未授权工具",
        "related_tools": ["does-not-exist"],
        "body": "只是一段指导文本。",
    })
    assert "error" in result
