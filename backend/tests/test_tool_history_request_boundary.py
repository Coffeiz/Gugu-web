from agent.security.sanitize import sanitize_messages


async def test_qq_interaction_ack_does_not_reuse_event_id(monkeypatch):
    from agent.gateway import qq

    calls = []

    async def fake_format(channel_id, chat_type):
        return "compat"

    async def fake_post(channel_id, target_id, text, msg_id, message_format):
        calls.append((channel_id, target_id, text, msg_id, message_format))

    monkeypatch.setattr(qq, "_message_format", fake_format)
    monkeypatch.setattr(qq, "_post", fake_post)

    await qq._qq_ack("channel", "c2c", "openid", "已确认", None)

    assert calls == [("channel", "openid", "已确认", None, "compat")]


def _tool_round(result="ok"):
    return [
        {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "call-1", "name": "demo", "input": {}}],
        },
        {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "call-1", "content": result}],
        },
    ]


def test_interaction_resume_tool_result_keeps_anthropic_pair():
    messages = [{"role": "user", "content": "删除它"}] + _tool_round('{"status":"confirmed"}')

    cleaned = sanitize_messages(messages)

    assert cleaned[0] == {"role": "user", "content": [{"type": "text", "text": "删除它"}]}
    assert cleaned[1]["content"][0]["id"] == "call-1"
    assert cleaned[2]["content"][0]["tool_use_id"] == "call-1"


def test_orphan_tool_result_is_removed_before_anthropic_request():
    messages = [
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "stale", "content": "old"}]},
        {"role": "user", "content": "继续"},
    ]

    cleaned = sanitize_messages(messages)

    assert cleaned == [{"role": "user", "content": [{"type": "text", "text": "继续"}]}]
