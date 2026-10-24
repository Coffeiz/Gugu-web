"""QQ 私聊 Markdown 格式使用流式路由，兼容格式和群聊维持普通发送。"""

import pytest

from agent.im.shortcuts import _qq_private_streaming_requested


@pytest.mark.parametrize(
    ("platform", "chat_type", "message_format", "expected"),
    [
        ("qq", "c2c", "markdown", True),
        ("qq", "c2c", "compat", False),
        ("qq", "group", "markdown", False),
        ("qq", "group", "compat", False),
        ("feishu", "c2c", "markdown", False),
    ],
)
def test_stream_mode_is_selected_by_qq_private_message_format(
    platform, chat_type, message_format, expected,
):
    """防止私聊格式之外的设置误让群聊或其他平台走 QQ 流接口。"""
    assert _qq_private_streaming_requested(platform, chat_type, message_format) is expected
