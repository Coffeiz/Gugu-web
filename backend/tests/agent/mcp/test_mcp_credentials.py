from agent.mcp.credentials import assemble_credentials, normalize_slots, secret_fields


def test_slots_support_header_and_query_without_exposing_values_in_template():
    slots = normalize_slots([
        {"id": "token", "label": "访问令牌", "target": "header", "name": "Authorization", "prefix": "Bearer "},
        {"id": "key", "label": "服务 Key", "target": "query", "name": "key"},
    ])
    endpoint, headers, query = assemble_credentials(
        "https://example.com/mcp?key={{secret:key}}", slots,
        {"token": "abc", "key": "xyz"},
    )
    assert endpoint == "https://example.com/mcp?key=xyz"
    assert headers == {"Authorization": "Bearer abc"}
    assert query == {}
    assert secret_fields(slots)[0]["name"] == "token"


def test_slots_append_query_when_endpoint_has_no_placeholder():
    slots = normalize_slots([
        {"id": "key", "label": "服务 Key", "target": "query", "name": "key"},
    ])
    endpoint, headers, query = assemble_credentials(
        "https://example.com/mcp?lang=zh", slots, {"key": "x y"},
    )
    assert endpoint == "https://example.com/mcp?lang=zh&key=x+y"
    assert headers == {}
    assert query == {"key": "x y"}
