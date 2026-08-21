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


@pytest.mark.asyncio
async def test_dispatch_flattens_multiple_inspected_images():
    name = "_test_image_search_inspection"

    async def handler(db, user_id, args):
        return {
            "_vision_images": [
                {"title": "候选一", "block": {"type": "image", "source": {"type": "base64", "data": "A"}}},
                {"title": "候选二", "block": {"type": "image", "source": {"type": "base64", "data": "B"}}},
            ],
            "inspection_note": "已读取 2 张候选图片。",
        }

    tool = Tool(name=name, description="仅供测试用", input_schema={"type": "object", "properties": {}}, handler=handler)
    registry.add(tool)
    try:
        content, artifact = await registry.dispatch("user-1", name, {})
    finally:
        registry._tools.pop(name, None)

    assert artifact is None
    assert [block["type"] for block in content] == ["text", "text", "image", "text", "image"]
    assert content[1]["text"] == "候选一"
    assert content[3]["text"] == "候选二"
