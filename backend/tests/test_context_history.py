"""provider 间历史消息适配回归测试。"""

from datetime import datetime, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from agent.context.history import build_chat_tool_events, build_history_parts, canonicalize_tool_messages


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


def test_user_message_time_is_a_stable_separate_reminder_in_history():
    from agent.models import AgentRequest

    message = SimpleNamespace(
        role="user", content="测试", content_json=None,
        sent_at=datetime(2026, 8, 22, 7, 22, tzinfo=timezone.utc),
        chat_type=None, platform_user_id=None, platform_user_name=None,
    )

    result = build_history_parts(
        [message], AgentRequest(message="", user_id="owner", user_name="小北"),
        use_anthropic=True,
        user_tz=ZoneInfo("Asia/Shanghai"),
    )

    assert result == [
        {"role": "user", "content": "测试"},
        {"role": "user", "content": "[system-reminder]\n08-22 15:22\n[/system-reminder]"},
    ]


def test_user_message_time_stays_after_complete_tool_turn():
    from agent.models import AgentRequest

    user = SimpleNamespace(
        role="user", content="删掉文件夹", content_json=None,
        sent_at=datetime(2026, 8, 22, 7, 22, tzinfo=timezone.utc),
        chat_type=None, platform_user_id=None, platform_user_name=None,
    )
    assistant = _message("assistant", [{
        "type": "tool_call", "id": "call-1", "name": "list_folders", "arguments": {},
    }])
    result = _message("user", [{
        "type": "tool_result", "tool_call_id": "call-1", "content": "[]",
    }])
    result = build_history_parts(
        [user, assistant, result], AgentRequest(message="", user_id="owner", user_name="小北"),
        use_anthropic=False, user_tz=ZoneInfo("Asia/Shanghai"),
    )

    assert [item["role"] for item in result] == ["user", "assistant", "tool", "user"]
    assert result[-1]["content"] == "[system-reminder]\n08-22 15:22\n[/system-reminder]"


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


def test_chat_tool_events_restore_call_and_result_as_one_bubble():
    from datetime import datetime, timezone

    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    result_created = datetime(2026, 8, 22, 7, 0, 1, tzinfo=timezone.utc)
    assistant = SimpleNamespace(
        id=10, created_at=created,
        content_json=[{"type": "tool_call", "id": "call-1", "name": "weather", "arguments": {"city": "南京"}}],
    )
    result = SimpleNamespace(
        id=11, created_at=result_created,
        content_json=[{"type": "tool_result", "tool_call_id": "call-1", "content": "晴天"}],
    )
    assert build_chat_tool_events([assistant, result]) == [{
        "id": "tool:call-1", "toolCallId": "call-1", "toolName": "weather",
        "toolInput": {"city": "南京"}, "toolResult": "晴天", "toolStatus": "success",
        "createdAt": created, "updatedAt": result_created, "toolDurationMs": 1000,
    }]


def test_chat_tool_events_restores_legacy_error_result_as_error():
    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    result_created = datetime(2026, 8, 22, 7, 0, 1, tzinfo=timezone.utc)
    assistant = SimpleNamespace(
        id=12, created_at=created,
        content_json=[{"type": "tool_call", "id": "call-2", "name": "permanent_delete", "arguments": {}}],
    )
    result = SimpleNamespace(
        id=13, created_at=result_created,
        content_json=[{"type": "tool_result", "tool_call_id": "call-2",
                       "content": '{"error":"文件夹不在回收站"}'}],
    )
    events = build_chat_tool_events([assistant, result])
    assert events[0]["toolStatus"] == "error"


def test_canonical_history_marks_legacy_error_tool_result():
    result = canonicalize_tool_messages([{
        "role": "tool", "tool_call_id": "call-3",
        "content": '{"error":"删除失败"}',
    }])
    assert result[0]["content"][0]["is_error"] is True


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
