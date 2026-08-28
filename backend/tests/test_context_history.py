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

    assert result[0]["content"][0] == {
        "type": "time-context",
        "text": "[system-reminder]\n消息时间：2026-08-22 15:22\n[/system-reminder]",
    }
    assert result[1] == {"role": "user", "content": "测试"}


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
        "type": "tool_call", "id": "call-1", "name": "list_folders", "arguments": {},
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
    assert result[2]["content"][0]["type"] == "text"
    assert result[3]["content"][0]["type"] == "text"


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
        "id": "tool:call-1", "toolCallId": "call-1", "timelineOrder": 11, "toolName": "weather",
        "toolLabel": "weather",
        "toolInput": {"city": "南京"}, "toolResult": "晴天", "toolStatus": "success",
        "createdAt": created, "updatedAt": result_created, "toolDurationMs": 1000,
    }]


def test_chat_tool_events_restore_name_when_result_is_scanned_before_call():
    """历史块顺序异常时也不能把具体工具名退化成通用「工具调用」。"""
    from datetime import datetime, timezone

    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    result_created = datetime(2026, 8, 22, 7, 0, 1, tzinfo=timezone.utc)
    result = SimpleNamespace(
        id=21, created_at=result_created,
        content_json=[{"type": "tool_result", "tool_call_id": "call-1", "content": "晴天"}],
    )
    assistant = SimpleNamespace(
        id=20, created_at=created,
        content_json=[{"type": "tool_call", "id": "call-1", "name": "weather", "arguments": {}}],
    )

    events = build_chat_tool_events([result, assistant])

    assert events[0]["toolName"] == "weather"
    assert events[0]["toolLabel"] == "weather"
    assert events[0]["toolResult"] == "晴天"


def test_chat_tool_events_use_tool_name_from_result_only_legacy_record():
    from datetime import datetime, timezone

    result = SimpleNamespace(
        id=22, created_at=datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc),
        content_json=[{
            "type": "tool_result", "tool_call_id": "call-legacy",
            "tool_name": "image_search", "content": "候选图",
        }],
    )

    events = build_chat_tool_events([result])

    assert events[0]["toolName"] == "image_search"
    assert events[0]["toolLabel"] == "图片搜索"


def test_chat_tool_events_restore_registered_tool_label():
    from datetime import datetime, timezone

    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    assistant = SimpleNamespace(
        id=14, created_at=created,
        content_json=[{"type": "tool_call", "id": "call-image", "name": "image_search", "arguments": {}}],
    )
    events = build_chat_tool_events([assistant])
    assert events[0]["toolName"] == "image_search"
    assert events[0]["toolLabel"] == "图片搜索"
    assert events[0]["timelineOrder"] == 14


def test_chat_tool_events_unwrap_fixed_adapter_call_tool():
    """刷新恢复时显示业务工具名，不把固定 Adapter 名称显示成「调用工具」。"""
    from datetime import datetime, timezone

    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    result_created = datetime(2026, 8, 22, 7, 0, 1, tzinfo=timezone.utc)
    assistant = SimpleNamespace(
        id=16, created_at=created,
        content_json=[{
            "type": "tool_call", "id": "call-adapter", "name": "call_tool",
            "arguments": {"name": "image_search", "arguments": {"query": "角色"}},
        }],
    )
    result = SimpleNamespace(
        id=17, created_at=result_created,
        content_json=[{"type": "tool_result", "tool_call_id": "call-adapter", "content": "结果"}],
    )

    events = build_chat_tool_events([assistant, result])

    assert events[0]["toolName"] == "image_search"
    assert events[0]["toolLabel"] == "图片搜索"
    assert events[0]["toolInput"] == {"query": "角色"}


def test_chat_tool_events_unwrap_openai_adapter_arguments():
    """OpenAI canonical arguments 是 JSON 字符串时也要恢复业务工具名。"""
    from datetime import datetime, timezone
    import json

    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    assistant = SimpleNamespace(
        id=18, created_at=created,
        content_json=[{
            "type": "tool_call", "id": "call-adapter-openai", "name": "call_tool",
            "arguments": json.dumps(
                {"name": "web_search", "arguments": {"query": "天气"}},
                ensure_ascii=False,
            ),
        }],
    )

    events = build_chat_tool_events([assistant])

    assert events[0]["toolName"] == "web_search"
    assert events[0]["toolLabel"] == "联网搜索"
    assert events[0]["toolInput"] == {"query": "天气"}


def test_chat_tool_events_restore_legacy_anthropic_tool_use():
    from datetime import datetime, timezone

    created = datetime(2026, 8, 22, 7, 0, tzinfo=timezone.utc)
    assistant = SimpleNamespace(
        id=15, created_at=created,
        content_json=[{"type": "tool_use", "id": "call-image", "name": "image_search", "input": {}}],
    )
    events = build_chat_tool_events([assistant])
    assert events[0]["toolLabel"] == "图片搜索"
    assert events[0]["toolInput"] == {}


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
