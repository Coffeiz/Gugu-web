from agent.context.canonical_context import CanonicalContext, digest
from agent.context.canonical_request import CanonicalRequest, stable_tool_schemas


def test_tool_schema_digest_is_order_stable():
    first = [{"name": "a", "input_schema": {"type": "object"}}]
    second = [{"input_schema": {"type": "object"}, "name": "a"}]
    request_a = CanonicalRequest(context=CanonicalContext(), tools=tuple(first))
    request_b = CanonicalRequest(context=CanonicalContext(), tools=tuple(second))
    assert digest(first) == digest(second)
    assert request_a.tool_schema_digest == request_b.tool_schema_digest
    assert [item["name"] for item in stable_tool_schemas(tuple(reversed(first + [{"name": "z"}])))] == ["a", "z"]
