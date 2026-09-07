from agent.context.message_roles import (
    is_internal_user_message,
    last_user_index,
    user_text_from_message,
)


def test_last_user_skips_system_reminders_and_runtime_context():
    messages = [
        {"role": "user", "content": "上一轮"},
        {"role": "user", "content": "[system-reminder]\n当前时间\n[/system-reminder]"},
        {"role": "user", "content": [{"type": "runtime-context", "text": "工作区"}]},
        {"role": "user", "content": "当前问题"},
    ]

    assert is_internal_user_message(messages[1])
    assert is_internal_user_message(messages[2])
    assert last_user_index(messages) == 3
    assert user_text_from_message(messages[3]) == "当前问题"


def test_user_text_keeps_text_next_to_image():
    message = {
        "role": "user",
        "content": [
            {"type": "text", "text": "看这张图"},
            {"type": "image", "source": {"type": "url"}},
        ],
    }

    assert not is_internal_user_message(message)
    assert user_text_from_message(message) == "看这张图"
