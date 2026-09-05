import pytest

from agent.capabilities.errors import CapabilityRegistrationError
from agent.capabilities.index import CapabilityIndex
from agent.capabilities.skill_registry import (
    deserialize_user_skill_metadata,
    serialize_user_skill_metadata,
)
from agent.capabilities.tool_registry import ToolCapabilityRegistry
from agent.capabilities.models import CapabilityMeta
from agent.tools.base import SkillRegistry, Tool


async def _handler(_db, _user_id, _args):
    return {"ok": True}


def _tool(name="demo", **kwargs):
    return Tool(
        name=name,
        description="完整说明",
        description_short=kwargs.pop("description_short", "查找演示资料。"),
        input_schema={"type": "object", "properties": {}},
        handler=_handler,
        **kwargs,
    )


def test_tool_adapter_preserves_metadata_without_copying_schema():
    registry = SkillRegistry()
    registry.add(_tool(category="search", related_skills=("web-search",)))
    item = ToolCapabilityRegistry(registry).metadata()[0]
    assert item.name == "demo"
    assert item.category == "search"
    assert item.related_skills == ("web-search",)


def test_tool_short_description_is_validated():
    registry = SkillRegistry()
    registry.add(_tool(description_short="x" * 101))
    with pytest.raises(CapabilityRegistrationError):
        ToolCapabilityRegistry(registry).metadata()


def test_tool_registry_snapshot_does_not_change_until_process_restart():
    registry = SkillRegistry()
    registry.add(_tool("before-restart"))
    snapshot = registry.snapshot()

    registry.add(_tool("after-snapshot"))

    assert snapshot.get("before-restart") is not None
    assert snapshot.get("after-snapshot") is None
    assert [item["function"]["name"] for item in registry.openai_schemas(
        ["before-restart", "after-snapshot"]
    )] == ["before-restart"]


def test_user_skill_metadata_snapshot_round_trips_without_skill_body():
    item = CapabilityMeta(
        name="user-skill", kind="skill", description_short="按需加载的做法",
        category="personal", related_tools=("web_search",), source="user",
        content_digest="old-digest", owner_fingerprint="owner-fingerprint",
    )

    encoded = serialize_user_skill_metadata((item,))
    decoded = deserialize_user_skill_metadata(encoded)

    assert decoded == (item,)
    assert "body" not in encoded[0]


@pytest.mark.asyncio
async def test_user_skill_metadata_snapshot_skips_live_database_read():
    item = CapabilityMeta(
        name="user-skill", kind="skill", description_short="冻结目录",
        related_tools=("web_search",), source="user",
    )

    class NoDatabaseRead:
        def __getattr__(self, name):
            raise AssertionError(f"不应读取数据库：{name}")

    index = await CapabilityIndex.from_registries_for_user(
        NoDatabaseRead(), "owner-1", tool_names=["web_search"],
        skill_metadata=(item,),
    )

    assert index.snapshot().skills["user-skill"] == item


def test_builtin_capability_snapshot_has_separate_tool_and_skill_maps():
    index = CapabilityIndex.from_registries(
        tool_names=["web_search"],
        skill_names=["web-search"],
    )
    snapshot = index.snapshot(["web_search"])
    assert set(snapshot.tools) == {"web_search"}
    assert set(snapshot.skills) == {"web-search"}
    assert all(len(item.description_short) <= 100 for item in snapshot.catalog)


def test_builtin_phase1_metadata_is_complete_and_relations_are_registered():
    index = CapabilityIndex.from_registries()
    snapshot = index.snapshot()

    assert len(snapshot.tools) == 106  # 含工作区 CRUD、邮件和用户技能管理工具
    assert len(snapshot.skills) == 12
    assert not snapshot.diagnostics
    assert all(item.category for item in snapshot.tools.values())
    assert all(1 <= len(item.description_short) <= 100 for item in snapshot.catalog)
    for skill in snapshot.skills.values():
        assert skill.related_tools
        assert set(skill.related_tools) <= set(snapshot.tools)


@pytest.mark.asyncio
async def test_admin_capability_catalog_exposes_metadata_without_schema_or_body():
    from app.api.v1.agent_admin import list_capabilities

    payload = await list_capabilities()
    assert len(payload["tools"]) == 106  # 含工作区 CRUD、邮件和用户技能管理工具
    assert len(payload["skills"]) == 12
    assert all("description_short" in item for item in payload["tools"])
    assert all("input_schema" not in item and "handler" not in item for item in payload["tools"])
    assert all("body" not in item for item in payload["skills"])
