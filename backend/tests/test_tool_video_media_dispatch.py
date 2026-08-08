"""agent/tools/base.py SkillRegistry.dispatch() 的 `_video_media` 特殊键回归测试。

这是 read_file 读视频最终把真正的 video content block 交给模型的唯一路径——
跟已有的 `_vision_image`（看图）走同一套机制，只是键名和内容块类型不同。
"""
import pytest

from agent.tools.base import Tool, registry


async def _video_handler(db, user_id, args: dict):
    return {
        "_video_media": {"type": "video", "source": {"type": "base64", "media_type": "video/mp4", "data": "AAAA"}},
        "note": "已读取视频《clip.mp4》。",
    }


@pytest.fixture
def video_tool():
    tool = Tool(
        name="_test_video_tool",
        description="仅供测试用",
        input_schema={"type": "object", "properties": {}},
        handler=_video_handler,
    )
    registry.add(tool)
    yield tool
    registry._tools.pop(tool.name, None)


@pytest.mark.asyncio
async def test_dispatch_converts_video_media_key_to_content_blocks(video_tool):
    content, artifact = await registry.dispatch("user-1", "_test_video_tool", {})

    assert artifact is None
    assert content == [
        {"type": "text", "text": "已读取视频《clip.mp4》。"},
        {"type": "video", "source": {"type": "base64", "media_type": "video/mp4", "data": "AAAA"}},
    ]
