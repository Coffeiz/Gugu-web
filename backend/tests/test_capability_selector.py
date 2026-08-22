from agent.capabilities.models import CapabilityMeta, CapabilitySnapshot
from agent.capabilities.selector import RegistryCapabilitySelector


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
