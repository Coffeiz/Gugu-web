import pytest

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


def test_header_credentials_reject_non_ascii_and_control_chars_without_echoing_value():
    slots = normalize_slots([
        {"id": "api_key", "label": "API Key", "target": "header",
         "name": "Authorization", "prefix": "Bearer "},
    ])
    for secret in ("测试凭据", "valid\r\nInjected: yes"):
        with pytest.raises(ValueError) as exc:
            assemble_credentials("https://example.com/mcp", slots, {"api_key": secret})
        assert secret not in str(exc.value)


def test_header_name_must_be_valid_ascii_token():
    with pytest.raises(ValueError, match="Header 名称"):
        normalize_slots([
            {"id": "key", "label": "Key", "target": "header",
             "name": "授权令牌"},
        ])
