import json

from agent.request_headers import redact_tool_request_headers


def test_tool_history_redacts_every_custom_header_value_but_keeps_names():
    source = {
        "url": "https://example.test",
        "headers": {
            "Authorization": "Bearer secret-token",
            "X-Custom": "private-value",
        },
    }

    redacted = redact_tool_request_headers(source)

    assert redacted == {
        "url": "https://example.test",
        "headers": {"Authorization": "[已隐藏]", "X-Custom": "[已隐藏]"},
    }
    assert "secret-token" not in json.dumps(redacted)
    assert "private-value" not in json.dumps(redacted)


def test_json_string_tool_history_redacts_every_custom_header_value():
    source = '{"headers":{"X-Custom":"private-value"}}'

    redacted = redact_tool_request_headers(source)

    assert json.loads(redacted) == {"headers": {"X-Custom": "[已隐藏]"}}
    assert "private-value" not in redacted
