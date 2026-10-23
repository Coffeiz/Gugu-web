"""IM tuple 流须同步网页正文，且不消费或重复发送平台最终响应。"""
from unittest.mock import AsyncMock

import pytest

from agent.im.stream_bridge import ImWebStreamBridge
from agent.models import AgentResponse


@pytest.mark.asyncio
async def test_platform_tuple_stream_is_not_a_second_web_display_source():
    bridge = ImWebStreamBridge('synthetic-user', 123, 'qq')
    bridge.publish = AsyncMock()
    response = AgentResponse(text='最终答复')
    items = [('token', '最终'), ('token', '答复'), ('round_end', '最终答复'), ('final', response)]

    async def source():
        for item in items:
            yield item

    received = [item async for item in bridge.mirror_stream(source())]
    assert received == items
    assert received[-1][1] is response
    bridge.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_display_event_is_forwarded_without_regenerating_identity():
    bridge = ImWebStreamBridge('synthetic-user', 123, 'qq')
    bridge.publish = AsyncMock()
    item = {'eventId': 'event-a', 'kind': 'assistant', 'sequence': 1,
            'createdAt': '2026-01-01T01:00:00Z', 'text': '答复'}
    await bridge.publish_display(item)
    bridge.publish.assert_awaited_once_with({'type': 'display_event', 'item': item})
