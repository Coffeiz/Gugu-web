"""provider 间历史消息适配回归测试。"""

from types import SimpleNamespace

from agent.context.history import build_history_parts, canonicalize_tool_messages


def _message(role, content_json):
    return SimpleNamespace(
        role=role,
        content="",
        content_json=content_json,
        sent_at=None,
        chat_type=None,
        platform_user_id=None,
        platform_user_name=None,
    )


def test_anthropic_history_keeps_native_tool_blocks():
    blocks = [{"type": "tool_use", "id": "call-1", "name": "weather", "input": {"city": "南京"}}]
    result = build_history_parts([_message("assistant", blocks)], None, use_anthropic=True)
    assert result == [{"role": "assistant", "content": blocks}]


def test_openai_history_converts_anthropic_tool_turn():
    assistant = _message("assistant", [{
        "type": "tool_use", "id": "call-1", "name": "weather", "input": {"city": "南京"},
    }])
    tool_result = _message("user", [{
        "type": "tool_result", "tool_use_id": "call-1", "content": "晴天",
    }])
    result = build_history_parts([assistant, tool_result], None, use_anthropic=False)
    assert result[0]["role"] == "assistant"
    assert result[0]["tool_calls"][0]["function"]["name"] == "weather"
    assert result[1] == {"role": "tool", "tool_call_id": "call-1", "content": "晴天"}


def test_canonical_history_normalizes_openai_tool_turn():
    messages = [
        {
            "role": "assistant", "content": "",
            "tool_calls": [{
                "id": "call-1", "type": "function",
                "function": {"name": "weather", "arguments": '{"city":"南京"}'},
            }],
        },
        {"role": "tool", "tool_call_id": "call-1", "content": "晴天"},
    ]
    assert canonicalize_tool_messages(messages) == [
        {"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-1", "name": "weather",
            "arguments": '{"city":"南京"}',
        }]},
        {"role": "tool", "content": [{
            "type": "tool_result", "tool_call_id": "call-1", "content": "晴天",
        }]},
    ]


def test_canonical_history_keeps_openai_tool_calls_when_content_is_null():
    messages = [{
        "role": "assistant", "content": None,
        "tool_calls": [{
            "id": "call-1", "type": "function",
            "function": {"name": "weather", "arguments": "{}"},
        }],
    }]
    result = canonicalize_tool_messages(messages)
    assert result[0]["content"][0] == {
        "type": "tool_call", "id": "call-1", "name": "weather", "arguments": "{}",
    }


def test_canonical_tool_turn_is_rendered_for_both_wire_formats():
    assistant = _message("assistant", [{
        "type": "tool_call", "id": "call-1", "name": "weather",
        "arguments": {"city": "南京"},
    }])
    result = _message("tool", [{
        "type": "tool_result", "tool_call_id": "call-1", "content": "晴天",
    }])

    openai = build_history_parts([assistant, result], None, use_anthropic=False)
    assert openai[0]["tool_calls"][0]["function"]["arguments"] == '{"city":"南京"}'
    assert openai[1] == {"role": "tool", "tool_call_id": "call-1", "content": "晴天"}

    anthropic = build_history_parts([assistant, result], None, use_anthropic=True)
    assert anthropic == [
        {"role": "assistant", "content": [{
            "type": "tool_use", "id": "call-1", "name": "weather",
            "input": {"city": "南京"},
        }]},
        {"role": "user", "content": [{
            "type": "tool_result", "tool_use_id": "call-1", "content": "晴天",
        }]},
    ]


def test_history_recursively_replaces_nested_image_payloads():
    assistant = _message("assistant", [{
        "type": "tool_result",
        "tool_use_id": "call-1",
        "content": [{
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "x" * 10000},
        }],
    }])

    result = build_history_parts([assistant], None, use_anthropic=True)

    nested = result[0]["content"][0]["content"][0]
    assert nested == {"type": "text", "text": "[图片已查看]"}
