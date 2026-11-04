"""IM 入队幂等回归：重复平台事件不能启动第二个 run。"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core import redis as R
from app.core.redis import _DEDUP_TTL_SECONDS, _dedup_key


_PAYLOAD_BASE = {
    "platform": "qq",
    "channel_id": "bot-1",
    "chat_type": "group",
    "chat_id": "group-1",
    "platform_user_id": "member-1",
    "message_id": "msg-1",
}


def test_dedup_key_is_stable_but_scoped_to_platform_conversation():
    """同一平台事件重投命中同一键；不同 Bot 或会话的相同 ID 不相互吞消息。"""
    key = _dedup_key(dict(_PAYLOAD_BASE))
    assert key == _dedup_key(dict(_PAYLOAD_BASE))
    assert key.startswith("im:seen:")
    assert key != _dedup_key({**_PAYLOAD_BASE, "channel_id": "bot-2"})
    assert key != _dedup_key({**_PAYLOAD_BASE, "chat_id": "group-2"})
    assert key != _dedup_key({**_PAYLOAD_BASE, "message_id": "msg-2"})


@pytest.mark.parametrize("payload", [
    {"platform": "qq"},
    {"message_id": "msg-1"},
    {"platform": "qq", "message_id": "   "},
])
def test_missing_platform_message_identity_disables_dedup(payload):
    """缺少稳定平台消息身份时放行，不用正文哈希误伤用户重复发言。"""
    assert _dedup_key(payload) == ""


@pytest.mark.asyncio
async def test_async_enqueue_atomically_deduplicates_and_appends():
    """去重标记和 XADD 在一个 Redis 脚本中完成，避免标记成功但入队失败。"""
    client = MagicMock()
    client.eval = AsyncMock(return_value=b"1234-0")
    with patch.object(R, "get_redis", return_value=client):
        result = await R.produce(R.IM_INBOUND_STREAM, dict(_PAYLOAD_BASE))

    assert result == b"1234-0"
    args = client.eval.call_args.args
    assert args[:3] == (R._ENQUEUE_SCRIPT, 2, _dedup_key(_PAYLOAD_BASE))
    assert args[3] == R.IM_INBOUND_STREAM
    assert args[4] == 10000
    assert args[6] == _DEDUP_TTL_SECONDS


@pytest.mark.asyncio
async def test_async_duplicate_platform_message_is_not_enqueued_twice():
    """Redis 原子脚本识别重复平台消息并返回空结果。"""
    client = MagicMock()
    client.eval = AsyncMock(return_value=None)
    with patch.object(R, "get_redis", return_value=client):
        result = await R.produce(R.IM_INBOUND_STREAM, dict(_PAYLOAD_BASE))
    assert result is None
    client.eval.assert_awaited_once()


def test_sync_enqueue_uses_same_atomic_deduplication():
    """同步平台回调与异步网关共用相同幂等键和原子入队脚本。"""
    client = MagicMock()
    client.eval.return_value = b"5678-0"
    with patch.object(R, "get_redis_sync", return_value=client):
        result = R.produce_sync(R.IM_INBOUND_STREAM, dict(_PAYLOAD_BASE))

    assert result == b"5678-0"
    args = client.eval.call_args.args
    assert args[:3] == (R._ENQUEUE_SCRIPT, 2, _dedup_key(_PAYLOAD_BASE))
    assert args[3] == R.IM_INBOUND_STREAM
    assert args[6] == _DEDUP_TTL_SECONDS


@pytest.mark.asyncio
async def test_non_inbound_stream_does_not_use_im_message_deduplication():
    """反思等其他 Redis stream 保持原有逐任务入队语义。"""
    client = MagicMock()
    client.eval = AsyncMock(return_value=b"9876-0")
    with patch.object(R, "get_redis", return_value=client):
        result = await R.produce("memory:reflection", dict(_PAYLOAD_BASE))
    assert result == b"9876-0"
    assert client.eval.call_args.args[2] == ""
