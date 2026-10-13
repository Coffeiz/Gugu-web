from __future__ import annotations

import pytest
from sqlalchemy import select

from agent.capabilities.errors import CapabilityRegistrationError
from agent.capabilities.index import CapabilityIndex
from agent.capabilities.skill_registry import SkillCapabilityRegistry, validate_user_skill
from agent.tools import registry as tool_registry
from agent.tools.skill_management import _create_skill, _list_skills
from agent.tools.meta import _use_skill
from agent.interactions.confirmations import confirmation_payload
from agent.tools.base import Tool, reset_dispatch_session, set_dispatch_session
from agent.im import imctx
from app.models import UserSkill


def _payload(**overrides):
    value = {
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
    ("name", ""),
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
    await registry.create_user_skill(db, user_a.id, **_payload())
    await registry.create_user_skill(
        db, user_b.id, **_payload(name="另一份简报"),
    )
    hidden = await registry.create_user_skill(
        db, user_a.id, **_payload(name="停用简报"),
    )
    hidden.enabled = False
    await db.commit()

    visible = await registry.user_metadata(db, user_a.id)
    assert [item.name for item in visible] == ["U1"]
    assert visible[0].display_name == "晨间简报"


@pytest.mark.asyncio
async def test_list_skills_returns_only_current_users_metadata_without_bodies(db, user_a, user_b):
    registry = SkillCapabilityRegistry()
    disabled = await registry.create_user_skill(
        db, user_a.id, **_payload(name="停用简报"),
    )
    await registry.create_user_skill(
        db, user_b.id, **_payload(name="其他用户的简报"),
    )
    disabled.enabled = False
    await registry.create_user_skill(
        db, user_a.id, **_payload(name="每周复盘"),
    )
    await db.commit()

    result = await _list_skills(db, user_a.id, {})

    from agent import skills as builtin_skills

    assert result["count"] == len(builtin_skills.skill_metadata()) + 2
    listed = {row["id"]: row for row in result["skills"]}
    assert {"U1", "U2"} <= listed.keys()
    assert "S12" in listed
    assert listed["S12"]["source"] == "builtin"
    assert listed["U1"]["name"] == "停用简报"
    assert listed["U2"]["name"] == "每周复盘"
    assert listed["U1"]["description_short"]
    assert not any(row["name"] == "其他用户的简报" for row in result["skills"])
    assert all("body" not in row for row in result["skills"])
    assert all("content_digest" not in row for row in result["skills"])
    assert listed["U1"]["enabled"] is False
    assert listed["U1"]["source"] == "user"


@pytest.mark.asyncio
async def test_list_skills_requires_account_context():
    assert await _list_skills(None, None, {}) == {"error": "列出技能需要当前账号上下文"}


@pytest.mark.asyncio
async def test_user_skill_rejects_unknown_tool_and_allocates_non_reusable_ids(db, user_a):
    registry = SkillCapabilityRegistry()
    with pytest.raises(CapabilityRegistrationError, match="未知工具"):
        await registry.create_user_skill(
            db, user_a.id, **_payload(related_tools=["does-not-exist"]),
        )
    # 工具关联只描述流程，不依赖当前会话权限，也不授予调用权。
    row = await registry.create_user_skill(db, user_a.id, **_payload())
    assert row.related_tools == ["http_get"]
    second = await registry.create_user_skill(db, user_a.id, **_payload(name="另一个晨报"))
    assert (row.skill_id, second.skill_id) == ("U1", "U2")
    await registry.delete_user_skill(db, user_a.id, row.skill_id)
    third = await registry.create_user_skill(db, user_a.id, **_payload(name="第三份晨报"))
    assert third.skill_id == "U3"


@pytest.mark.asyncio
async def test_user_skill_name_can_match_system_skill_name_because_ids_are_distinct(db, user_a):
    from agent import skills

    row = await SkillCapabilityRegistry().create_user_skill(
        db, user_a.id, **_payload(name="天气"),
    )
    assert row.skill_id == "U1"
    assert any(item["id"] == "S12" and item["name"] == row.name for item in skills.skill_metadata())


@pytest.mark.asyncio
async def test_user_skill_is_merged_into_user_capability_index(db, user_a):
    await SkillCapabilityRegistry().create_user_skill(
        db, user_a.id, **_payload(),
    )
    index = await CapabilityIndex.from_registries_for_user(db, user_a.id)
    assert "U1" in index._skills
    assert index._skills["U1"].source == "user"
    assert index._skills["U1"].display_name == "晨间简报"
    assert index._skills["U1"].content_digest
    assert index._skills["U1"].owner_fingerprint
    from agent.capabilities.injector import catalog_block
    catalog = catalog_block(index.snapshot(), kind="skill")
    assert "- **晨间简报**（内部 ID：`U1`）" in catalog
    assert "整理当天值得关注的事项" in catalog

    restricted = await CapabilityIndex.from_registries_for_user(db, user_a.id, tool_names=[])
    assert "U1" in restricted._skills
    assert restricted._skills["U1"].related_tools == ()


@pytest.mark.asyncio
async def test_use_skill_loads_owned_body_and_refreshes_digest(db, user_a):
    registry = SkillCapabilityRegistry()
    row = await registry.create_user_skill(
        db, user_a.id, **_payload(),
    )
    first = await _use_skill(db, user_a.id, {"id": row.skill_id})
    assert first["content"] == row.body
    assert first["skill_name"] == row.name
    assert first["_capability_usage"]["source"] == "user"
    assert first["_capability_usage"]["owner_fingerprint"]
    first_digest = first["_capability_usage"]["content_digest"]

    from agent.tools.base import reset_dispatch_session, set_dispatch_session
    loaded_state = {row.skill_id: first_digest}
    dispatch_token = set_dispatch_session(
        None, skill_state=loaded_state,
    )
    try:
        already_loaded = await _use_skill(db, user_a.id, {"id": row.skill_id})
    finally:
        reset_dispatch_session(dispatch_token)
    assert already_loaded["already_loaded"] is True
    assert already_loaded["skill_name"] == row.name

    row = await registry.update_user_skill(
        db, user_a.id, row.skill_id, body="更新后的用户 Skill 正文。",
    )
    dispatch_token = set_dispatch_session(
        None, skill_state=loaded_state,
    )
    try:
        second = await _use_skill(db, user_a.id, {"id": row.skill_id})
    finally:
        reset_dispatch_session(dispatch_token)
    assert second["content"] == "更新后的用户 Skill 正文。"
    assert second["_capability_usage"]["content_digest"] != first_digest

    row.enabled = False
    await db.flush()
    disabled = await _use_skill(db, user_a.id, {"id": row.skill_id})
    assert "error" in disabled


@pytest.mark.asyncio
async def test_create_skill_adapter_uses_registry_and_returns_structured_result(db, user_a):
    args = {
        "name": "夜间复盘",
        "description_short": "把当天事项整理成复盘清单",
        "related_tools": [],
        "body": "按完成、阻塞和下一步三个部分输出。",
        "managed_by": "user",
    }
    result = await _create_skill(db, user_a.id, args)
    assert result["success"] is True
    assert result["skill"]["id"] == "U1"
    assert result["skill"]["managed_by"] == "user"


@pytest.mark.asyncio
async def test_skill_tool_dispatch_publishes_directory_change_for_other_clients(db, user_a, monkeypatch):
    import json

    from app.core import events

    published = []

    async def capture_publish(user_id, *resources, **kwargs):
        published.append((user_id, resources, kwargs))
        return True

    monkeypatch.setattr(events, "publish", capture_publish)
    result_json, artifact = await tool_registry.dispatch(user_a.id, "create_skill", {
        "name": "夜间复盘",
        "description_short": "整理当天事项",
        "related_tools": [],
        "body": "总结完成项、阻塞项和下一步。",
        "managed_by": "assistant",
    })

    assert artifact is None
    assert json.loads(result_json)["success"] is True
    assert published == [(user_a.id, ("skills",), {"file_op": None})]


@pytest.mark.asyncio
@pytest.mark.asyncio
async def test_create_skill_adapter_rejects_unknown_tool_reference(db, user_a):
    result = await _create_skill(db, user_a.id, {
        "name": "受限技能",
        "description_short": "不应关联未授权工具",
        "related_tools": ["does-not-exist"],
        "body": "只是一段指导文本。",
        "managed_by": "assistant",
    })
    assert "error" in result


@pytest.mark.asyncio
async def test_skill_manager_controls_agent_delete_confirmation(db, user_a):
    from agent.tools.skill_management import _delete_skill

    registry = SkillCapabilityRegistry()
    user_skill = await registry.create_user_skill(db, user_a.id, **_payload())
    await db.commit()
    blocked = await _delete_skill(db, user_a.id, {"id": user_skill.skill_id})
    confirmation = confirmation_payload(blocked)
    assert confirmation is not None
    assert await db.scalar(select(UserSkill).where(UserSkill.skill_id == user_skill.skill_id)) is not None

    assistant_skill = await registry.create_user_skill(
        db, user_a.id,
        **_payload(name="咕咕整理的流程", managed_by="assistant"),
    )
    await db.commit()
    deleted = await _delete_skill(db, user_a.id, {"id": assistant_skill.skill_id})
    assert deleted["success"] is True
    assert deleted["_confirm_gate_authorized"] == "confirmation_gate"
    assert await db.scalar(select(UserSkill).where(UserSkill.skill_id == assistant_skill.skill_id)) is None


def test_skill_creation_is_not_permission_or_confirmation_gated():
    from agent.tools.skill_management import SKILL_MANAGEMENT_TOOLS

    tools = {tool.name: tool for tool in SKILL_MANAGEMENT_TOOLS}
    assert tools["create_skill"].requires_confirmation is False
    assert tools["create_skill"].mutates is True
    assert tools["create_skill"].input_schema["properties"]["managed_by"]["enum"] == ["user", "assistant"]


@pytest.mark.asyncio
async def test_group_member_cannot_discover_or_update_owner_skill(db, user_a):
    from agent.tools.meta import _get_tool_schema

    skill = await SkillCapabilityRegistry().create_user_skill(db, user_a.id, **_payload())
    await db.commit()
    imctx.set_im(
        "qq", "member-message", "bot-1", "group-1", "member-1", "group",
        allowed_tool_names=[], im_role="member",
    )
    try:
        schema_result = await _get_tool_schema(
            db, user_a.id, {"tools": ["update_skill"]},
        )
        assert "tool_schemas" not in schema_result
        assert schema_result["rejected"] == ["update_skill"]

        result_json, artifact = await tool_registry.dispatch(
            user_a.id,
            "update_skill",
            {"id": skill.skill_id, "body": "群成员注入的内容"},
        )
        assert artifact is None
        assert "没有使用该工具的权限" in result_json
        await db.refresh(skill)
        assert skill.body == _payload()["body"]
    finally:
        imctx.clear()


def _mcp_tool(name="mcp_notes_search"):
    async def handler(db, user_id, args):
        return {"ok": True}

    return Tool(
        name=name, description="搜索笔记", description_short="搜索用户笔记",
        input_schema={"type": "object", "properties": {}}, handler=handler,
        category="mcp", source="mcp",
    )


@pytest.mark.asyncio
async def test_skill_tools_list_tracks_mcp_disable_and_reenable(db, user_a, monkeypatch):
    from types import SimpleNamespace

    from app.api.v1 import user_skills
    from agent.mcp.manager import mcp_manager

    state = SimpleNamespace(enabled=True)
    import app.core.config as config
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(mcp=state))
    calls = []

    async def list_user_tools(user_id):
        calls.append(user_id)
        return [_mcp_tool()]

    monkeypatch.setattr(mcp_manager, "list_user_tools", list_user_tools)

    enabled = await user_skills.list_skills(user_a, db)
    assert any(tool["name"] == "mcp_notes_search" for tool in enabled["tools"])

    state.enabled = False
    disabled = await user_skills.list_skills(user_a, db)
    assert not any(tool["name"] == "mcp_notes_search" for tool in disabled["tools"])
    assert calls == [user_a.id]

    state.enabled = True
    reopened = await user_skills.list_skills(user_a, db)
    assert any(tool["name"] == "mcp_notes_search" for tool in reopened["tools"])
    assert calls == [user_a.id, user_a.id]


@pytest.mark.asyncio
async def test_skill_api_accepts_active_mcp_and_preserves_link_while_disabled(db, user_a, monkeypatch):
    from types import SimpleNamespace

    from app.api.v1 import user_skills
    from agent.mcp.manager import mcp_manager
    from app.core import events

    published = []

    async def capture_publish(user_id, *resources, **kwargs):
        published.append((user_id, resources, kwargs))

    monkeypatch.setattr(events, "publish", capture_publish)

    state = SimpleNamespace(enabled=True)
    import app.core.config as config
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(mcp=state))

    async def list_user_tools(user_id):
        return [_mcp_tool()]

    monkeypatch.setattr(mcp_manager, "list_user_tools", list_user_tools)
    payload = user_skills.UserSkillPayload(
        **_payload(related_tools=["mcp_notes_search"]),
    )
    created = await user_skills.create_skill(payload, user_a, db)
    assert created["related_tools"] == ["mcp_notes_search"]
    assert created["managed_by"] == "user"
    assert published == [(user_a.id, ("skills",), {})]

    state.enabled = False
    updated = await user_skills.update_skill(
        created["id"],
        user_skills.UserSkillPatch(name="更新名称", related_tools=["mcp_notes_search"]),
        user_a, db,
    )
    assert updated["name"] == "更新名称"
    assert updated["related_tools"] == ["mcp_notes_search"]
    assert updated["managed_by"] == "user"
    assert published == [
        (user_a.id, ("skills",), {}),
        (user_a.id, ("skills",), {}),
    ]
    updated = await user_skills.update_skill(
        created["id"],
        user_skills.UserSkillPatch(related_tools=["mcp_notes_search", "mcp_unavailable_tool"]),
        user_a, db,
    )
    assert updated["related_tools"] == ["mcp_notes_search", "mcp_unavailable_tool"]


@pytest.mark.asyncio
async def test_skill_editor_takes_over_assistant_managed_skill(db, user_a):
    row = await SkillCapabilityRegistry().create_user_skill(
        db, user_a.id,
        **_payload(name="咕咕整理的流程", managed_by="assistant"),
    )
    await db.commit()

    from app.api.v1 import user_skills
    updated = await user_skills.update_skill(
        row.skill_id,
        user_skills.UserSkillPatch(description_short="用户接管后的描述"),
        user_a, db,
    )
    assert updated["description_short"] == "用户接管后的描述"
    assert updated["managed_by"] == "user"


@pytest.mark.asyncio
async def test_skill_mcp_related_tools_are_only_injected_when_dynamic_tool_is_available(db, user_a):
    tool = _mcp_tool()
    row = await SkillCapabilityRegistry().create_user_skill(
        db, user_a.id, dynamic_tools=[tool],
        **_payload(related_tools=[tool.name]),
    )
    await db.commit()

    disabled = await CapabilityIndex.from_registries_for_user(db, user_a.id)
    assert disabled._skills[row.skill_id].related_tools == ()

    enabled = await CapabilityIndex.from_registries_for_user(
        db, user_a.id, dynamic_tools=[tool],
    )
    assert enabled._skills[row.skill_id].related_tools == (tool.name,)


@pytest.mark.asyncio
async def test_agent_skill_creation_can_reference_mcp_tools_without_permission_grant(db, user_a):
    tool = _mcp_tool()
    snapshot = tool_registry.snapshot_with_extras([tool])
    token = set_dispatch_session(None, tool_snapshot=snapshot)
    try:
        args = {
            "name": "MCP 技能",
            "description_short": "通过 MCP 搜索笔记",
            "related_tools": [tool.name], "body": "搜索相关笔记并总结。",
            "managed_by": "assistant",
        }
        created = await _create_skill(db, user_a.id, args)
        assert created["success"] is True
        assert created["skill"]["related_tools"] == [tool.name]
        assert created["skill"]["managed_by"] == "assistant"
    finally:
        reset_dispatch_session(token)
