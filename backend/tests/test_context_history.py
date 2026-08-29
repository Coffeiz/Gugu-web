"""provider 间历史消息适配回归测试。"""

from types import SimpleNamespace

from agent.context.history import build_history_parts


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
