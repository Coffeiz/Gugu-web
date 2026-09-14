"""search_memory 工具层边界回归（PRD-KNOWLEDGE-2）。

knowledge 域独立后：工具层 source=knowledge 被拒绝并引导 read_knowledge；
记忆源正常透传 service；service 层函数仍保留 knowledge 能力供内部调用。
"""
import pytest

from agent.tools import memory as memory_tools


@pytest.mark.asyncio
async def test_search_memory_rejects_knowledge_source_and_guides(monkeypatch):
    called = []

    async def fail_search(*args, **kwargs):
        called.append((args, kwargs))
        return {"results": [{"source_id": "不应命中"}]}

    monkeypatch.setattr(memory_tools, "search_memory", fail_search)

    result = await memory_tools._search_memory(None, "user-a", {"query": "部署", "source": "knowledge"})

    assert "error" in result
    assert "read_knowledge" in result["error"]
    assert called == []  # 未透传到 service


@pytest.mark.asyncio
async def test_search_memory_still_passes_memory_sources_to_service(monkeypatch):
    captured: dict = {}

    async def fake_search(user_id, query, *, scope, source, strategy, limit, db, im_context):
        captured.update(source=source, query=query)
        return {"results": []}

    monkeypatch.setattr(memory_tools, "search_memory", fake_search)

    result = await memory_tools._search_memory(None, "user-a", {"query": "上周", "source": "daily"})

    assert result == {"results": []}
    assert captured == {"source": "daily", "query": "上周"}


@pytest.mark.asyncio
async def test_tool_schema_drops_knowledge_from_source_enum():
    tools = {tool.name: tool for tool in memory_tools.MemorySkill.tools}
    enum = tools["search_memory"].input_schema["properties"]["source"]["enum"]
    assert "knowledge" not in enum
    assert set(enum) == {"all", "profile", "pattern", "daily", "memory"}


def test_knowledge_tools_live_in_knowledge_skill_not_memory():
    """knowledge 域工具独立注册：MemorySkill 不再包含，KnowledgeSkill 全量承接。"""
    memory_names = {tool.name for tool in memory_tools.MemorySkill.tools}
    assert not memory_names & {"save_knowledge", "update_knowledge", "delete_knowledge", "read_knowledge"}

    from agent.tools.knowledge import KnowledgeSkill

    knowledge_names = {tool.name for tool in KnowledgeSkill.tools}
    assert knowledge_names == {"save_knowledge", "update_knowledge", "delete_knowledge", "read_knowledge"}
