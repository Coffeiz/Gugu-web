"""记忆与知识工具的运行时边界。"""
import pytest

from agent.tools import memory as memory_tools


@pytest.mark.asyncio
async def test_search_memory_rejects_knowledge_source_before_memory_service(monkeypatch):
    called = []

    async def fail_search(*args, **kwargs):
        called.append((args, kwargs))
        return {"results": [{"source_id": "不应命中"}]}

    monkeypatch.setattr(memory_tools, "search_memory", fail_search)

    result = await memory_tools._search_memory(None, "user-a", {"query": "部署", "source": "knowledge"})

    assert "error" in result
    assert called == []


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


def test_runtime_tool_registry_keeps_memory_and_knowledge_as_separate_capabilities():
    """生产注册表按能力组暴露工具，避免知识工具被记忆能力预选或授权。"""
    from agent.tools import registry

    snapshot = registry.snapshot()
    memory_names = set(snapshot.tools_of(["memory"]))
    knowledge_names = set(snapshot.tools_of(["knowledge"]))
    knowledge_tools = {"save_knowledge", "update_knowledge", "delete_knowledge", "read_knowledge"}

    assert "search_memory" in memory_names
    assert not memory_names & knowledge_tools
    assert knowledge_tools <= knowledge_names
    assert not memory_names & knowledge_names
