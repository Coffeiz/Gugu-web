"""保护所有已登记 IM 来源都能在动态提示词中被识别。"""

import pytest

from agent.context import builder
from agent.im.context_policy import IM_SOURCES
from app.services.im_platforms import IM_PLATFORMS

ALL_IM_SOURCES = tuple(dict.fromkeys((*IM_SOURCES, *IM_PLATFORMS)))


@pytest.mark.parametrize("source", ALL_IM_SOURCES)
def test_every_registered_im_source_is_named_in_dynamic_prompt(source):
    """新增 IM 来源若未加入提示词映射，必须在这里失败，避免模型猜错当前渠道。"""
    display_name = builder._SOURCE_NAME.get(source)
    assert display_name, f"IM 来源 {source!r} 缺少提示词显示名称"

    _, dynamic, _ = builder.build_split(
        "default", "测试用户", [], [], source=source,
    )

    assert f"本次对话来自：**{display_name}**" in dynamic
    assert f"你当前正在通过{display_name}与用户实时聊天。" in dynamic


def test_connected_wechat_is_shown_during_another_im_source_session():
    """微信已连接时，即使当前会话来自 Telegram，也不能误报未连接。"""
    _, dynamic, _ = builder.build_split(
        "default", "测试用户", [], [],
        source="telegram",
        im_channels={"wechat": True},
    )

    assert "微信 已连 ✅" in dynamic
