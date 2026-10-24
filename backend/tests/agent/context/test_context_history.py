"""provider 间历史消息适配回归测试。"""

from datetime import datetime, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

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

    assert result[0]["content"][0] == {
        "type": "time-context",
        "text": "[system-reminder]\n消息时间：2026-08-22 15:22\n[/system-reminder]",
    }
    assert result[1] == {"role": "user", "content": "测试"}


@pytest.mark.parametrize("use_anthropic", [False, True])
def test_history_skips_empty_assistant_display_only_row(use_anthropic):
    from agent.models import AgentRequest

    display_only = SimpleNamespace(
        role="assistant",
        content="",
        content_json=None,
        display_timeline=[
            {"kind": "assistant", "text": "部分输出"},
            {"kind": "tool", "toolStatus": "success"},
        ],
        files=None,
        quoted_text=None,
        sent_at=None,
        chat_type=None,
        platform_user_id=None,
        platform_user_name=None,
    )

    result = build_history_parts(
        [display_only],
        AgentRequest(message="", user_id="owner", user_name="小北"),
        use_anthropic=use_anthropic,
    )

    assert result == []


def test_history_restores_quoted_text_without_rewriting_message_content():
    from agent.models import AgentRequest

    message = SimpleNamespace(
        role="user",
        content="嗯",
        quoted_text="双曲线三号是星际荣耀的技术路线",
        content_json=None,
        sent_at=None,
        chat_type="group",
        platform_user_id="member-1",
        platform_user_name="小北",
    )

    result = build_history_parts(
        [message], AgentRequest(message="", user_id="owner", user_name="小北"),
        use_anthropic=True,
    )

    assert "双曲线三号是星际荣耀的技术路线" in result[0]["content"]
    assert result[0]["content"].endswith("嗯")


def test_history_restores_quoted_text_for_all_im_sources_and_providers():
    from agent.models import AgentRequest

    for source in ("qq", "feishu", "wechat"):
        message = SimpleNamespace(
            role="user",
            content="继续",
            quoted_text="上一条平台消息的正文",
            content_json=None,
            sent_at=None,
            chat_type="group",
            platform_user_id="member-1",
            platform_user_name="小北",
        )
        request = AgentRequest(
            message="",
            user_id="owner",
            user_name="小北",
            source=source,
            chat_id="group-1",
        )

        for use_anthropic in (True, False):
            result = build_history_parts(
                [message], request, use_anthropic=use_anthropic,
            )
            assert "上一条平台消息的正文" in str(result)
            assert "继续" in str(result)


def test_user_message_time_stays_before_complete_tool_turn():
    from agent.models import AgentRequest

    user = SimpleNamespace(
        role="user", content="删掉文件夹", content_json=None,
        sent_at=datetime(2026, 8, 22, 7, 22, tzinfo=timezone.utc),
        chat_type=None, platform_user_id=None, platform_user_name=None,
    )
    assistant = _message("assistant", [{
        "type": "tool_call", "id": "call-1", "name": "list_dir", "arguments": {},
    }])
    result = _message("user", [{
        "type": "tool_result", "tool_call_id": "call-1", "content": "[]",
    }])
    result = build_history_parts(
        [user, assistant, result], AgentRequest(message="", user_id="owner", user_name="小北"),
        use_anthropic=False, user_tz=ZoneInfo("Asia/Shanghai"),
    )

    assert [item["role"] for item in result] == ["user", "user", "assistant", "tool"]
    assert result[0]["content"][0]["text"] == (
        "[system-reminder]\n消息时间：2026-08-22 15:22\n[/system-reminder]"
    )


def test_canonical_events_do_not_split_user_turn_timestamp_boundary():
    """RAG/schema 属于同一 turn，不能在它们前面重复插入消息时间。"""
    from agent.models import AgentRequest

    user = SimpleNamespace(
        role="user", content="今天天气如何", content_json=None,
        sent_at=datetime(2026, 8, 25, 0, 26, tzinfo=timezone.utc),
        chat_type=None, platform_user_id=None, platform_user_name=None,
    )
    rag = _message("user", [{
        "type": "knowledge-context", "scope": "owner-rag",
        "text": "南京近期天气记录", "content_hash": "rag-1",
    }])
    schema = _message("user", [{
        "type": "skill-schema", "skill_name": "weather", "tools": ["http_get"],
    }])
    next_user = SimpleNamespace(
        role="user", content="好潮湿", content_json=None,
        sent_at=None, chat_type=None, platform_user_id=None, platform_user_name=None,
    )

    result = build_history_parts(
        [user, rag, schema, next_user],
        AgentRequest(message="", user_id="owner", user_name="小北"),
        use_anthropic=True,
        user_tz=ZoneInfo("Asia/Shanghai"),
    )

    assert [item["role"] for item in result] == ["user", "user", "user", "user", "user"]
    assert result[0]["content"][0]["text"] == (
        "[system-reminder]\n消息时间：2026-08-25 08:26\n[/system-reminder]"
    )
    # 回放保留 canonical 类型，渲染推迟到 provider boundary（与注入形状一致）
    assert result[2]["content"][0]["type"] == "knowledge-context"
    assert result[3]["content"][0]["type"] == "skill-schema"


def test_anthropic_history_keeps_native_tool_blocks():
    blocks = [{"type": "tool_use", "id": "call-1", "name": "weather", "input": {"city": "南京"}}]
    result = build_history_parts([_message("assistant", blocks)], None, use_anthropic=True)
    assert result == [{"role": "assistant", "content": blocks}]


def test_anthropic_history_coerces_legacy_string_tool_arguments_to_object():
    assistant = _message("assistant", [{
        "type": "tool_call", "id": "call-legacy", "name": "weather",
        "arguments": '{"city":"南京"}',
    }])
    result = build_history_parts([assistant], None, use_anthropic=True)
    assert result == [{"role": "assistant", "content": [{
        "type": "tool_use", "id": "call-legacy", "name": "weather",
        "input": {"city": "南京"},
    }]}]
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
        {"role": "user", "content": [{
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


def test_anthropic_history_accepts_legacy_tool_use_id_and_drops_missing_id_result():
    assistant = _message("assistant", [{
        "type": "tool_call", "id": "call-legacy", "name": "weather", "arguments": {},
    }])
    legacy_result = _message("user", [{
        "type": "tool_result", "tool_use_id": "call-legacy", "content": "晴天",
    }])
    malformed_result = _message("user", [{
        "type": "tool_result", "content": "缺少调用 id",
    }])

    parts = build_history_parts(
        [assistant, legacy_result, malformed_result], None, use_anthropic=True,
    )

    assert parts[1]["content"] == [{
        "type": "tool_result", "tool_use_id": "call-legacy", "content": "晴天",
    }]
    assert all(
        block.get("tool_use_id")
        for message in parts
        for block in message.get("content", [])
        if isinstance(block, dict) and block.get("type") == "tool_result"
    )
