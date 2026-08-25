from agent.context.canonical_context import CanonicalContext, digest
from agent.context.canonical_context import DynamicTailKind, classify_dynamic_tail
from agent.context.canonical_request import CanonicalRequest, stable_tool_schemas


def test_tool_schema_digest_is_order_stable():
    first = [{"name": "a", "input_schema": {"type": "object"}}]
    second = [{"input_schema": {"type": "object"}, "name": "a"}]
    request_a = CanonicalRequest(context=CanonicalContext(), tools=tuple(first))
    request_b = CanonicalRequest(context=CanonicalContext(), tools=tuple(second))
    assert digest(first) == digest(second)
    assert request_a.tool_schema_digest == request_b.tool_schema_digest
    assert [item["name"] for item in stable_tool_schemas(tuple(reversed(first + [{"name": "z"}])))] == ["a", "z"]


def test_dynamic_tail_lifecycle_is_explicit():
    assert classify_dynamic_tail(name="rag", persistent=True) == DynamicTailKind.TURN_STABLE
    assert classify_dynamic_tail(name="time", changes_per_turn=True) == DynamicTailKind.REQUEST_VOLATILE
    assert classify_dynamic_tail(name="stance") == DynamicTailKind.SESSION_STABLE
