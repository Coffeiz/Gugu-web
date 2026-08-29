from __future__ import annotations

import pytest

from agent.capabilities.errors import CapabilityRegistrationError
from agent.capabilities.index import CapabilityIndex
from agent.capabilities.skill_registry import SkillCapabilityRegistry, validate_user_skill
from agent.tools import registry as tool_registry
from agent.tools.meta import _create_skill
from agent.tools.meta import _use_skill


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

    row = await registry.update_user_skill(
        db, user_a.id, row.slug, allowed_tool_names=set(tool_registry._tools),
        body="更新后的用户 Skill 正文。",
    )
    second = await _use_skill(db, user_a.id, {"name": row.slug})
    assert second["content"] == "更新后的用户 Skill 正文。"
    assert second["_capability_usage"]["content_digest"] != first_digest

    row.enabled = False
    await db.flush()
    disabled = await _use_skill(db, user_a.id, {"name": row.slug})
    assert "error" in disabled


@pytest.mark.asyncio
async def test_create_skill_adapter_uses_registry_and_returns_structured_result(db, user_a):
    result = await _create_skill(db, user_a.id, {
        "name": "夜间复盘",
        "description_short": "把当天事项整理成复盘清单",
        "related_tools": [],
        "body": "按完成、阻塞和下一步三个部分输出。",
    })
    assert result["success"] is True
    assert result["skill"]["slug"].startswith("user-skill-")


@pytest.mark.asyncio
async def test_create_skill_adapter_rejects_unavailable_tool(db, user_a):
    result = await _create_skill(db, user_a.id, {
        "name": "受限技能",
        "description_short": "不应关联未授权工具",
        "related_tools": ["does-not-exist"],
        "body": "只是一段指导文本。",
    })
    assert "error" in result
