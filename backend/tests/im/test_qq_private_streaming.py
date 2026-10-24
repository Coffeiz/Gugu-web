"""QQ 私聊只有显式启用实时流式时才走流式路由。"""

import pytest

from agent.im.shortcuts import _qq_private_streaming_requested


@pytest.mark.parametrize(
    ("platform", "chat_type", "message_format", "enabled", "expected"),
    [
        ("qq", "c2c", "markdown", True, True),
        ("qq", "c2c", "markdown", False, False),
        ("qq", "c2c", "compat", True, False),
        ("qq", "group", "markdown", True, False),
        ("qq", "group", "compat", False, False),
        ("feishu", "c2c", "markdown", True, False),
    ],
)
def test_stream_mode_requires_enabled_qq_private_chat(
    platform, chat_type, message_format, enabled, expected,
):
    """防止兼容格式、关闭状态、群聊或其他平台进入 QQ 私聊流接口。"""
    assert _qq_private_streaming_requested(
        platform, chat_type, message_format, enabled
    ) is expected
