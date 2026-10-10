from agent.capabilities.models import CapabilityMeta, CapabilitySnapshot
from agent.capabilities.selector import RegistryCapabilitySelector
from agent.capabilities.selector import RagCapabilitySelector
from agent.rag.models import RecallResult


def _snapshot():
    return CapabilitySnapshot(
        generation=1,
        tools={
            "a": CapabilityMeta("a", "tool", "查找天气。"),
            "b": CapabilityMeta("b", "tool", "搜索资料。"),
        },
        skills={},
    )


def test_selector_uses_rag_candidates_as_recommendation_order_only():
    result = RegistryCapabilitySelector(["unknown", "b", "a"]).select("搜索", _snapshot(), limit=1)
    assert result.tool_names == ("b", "a")


def test_selector_keeps_authorized_tools_when_rag_misses_them():
    result = RegistryCapabilitySelector(["b"]).select("搜索", _snapshot())
    assert result.tool_names == ("b", "a")


def test_selector_without_rag_keeps_compatibility_full_set():
    result = RegistryCapabilitySelector().select("任意请求", _snapshot())
    assert result.tool_names == ("a", "b")
    assert result.shadow is True


def test_capability_rag_keeps_authorized_tools_when_recommendation_is_partial(monkeypatch):
    async def fake_search(owner_id, documents, query, **kwargs):
        return [RecallResult(documents[1], 0.91)]

    monkeypatch.setattr("agent.capabilities.recommendation.search_documents_with_cache", fake_search)
    result = __import__("asyncio").run(
        RagCapabilitySelector("owner-1", shadow=False).select_async("搜索资料", _snapshot(), 5)
    )
    assert result.tool_names == ("b", "a")
    assert result.reasons == {"b": "能力目录 RAG 相关"}


def test_capability_rag_failure_does_not_change_authorized_set(monkeypatch):
    async def failed_search(*args, **kwargs):
        raise RuntimeError("sidecar unavailable")

    monkeypatch.setattr("agent.capabilities.recommendation.search_documents_with_cache", failed_search)
    result = __import__("asyncio").run(
        RagCapabilitySelector("owner-1", shadow=False).select_async("搜索资料", _snapshot(), 5)
    )
    assert result.tool_names == ("a", "b")
    assert result.shadow is True
