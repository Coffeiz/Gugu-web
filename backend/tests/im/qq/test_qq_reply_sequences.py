"""QQ 图文混排必须在流式与普通消息之间共享被动回复序号。"""
from __future__ import annotations

import asyncio
from collections import defaultdict

import pytest

from agent.gateway.qq import outbound
from agent.gateway.qq.client import QQAPIError


@pytest.fixture
def qq_reply_transport(monkeypatch):
    """模拟 Redis 原子计数与 QQ 按 msg_id + msg_seq 去重的协议。"""
    class RedisCounter:
        def __init__(self):
            self.values = defaultdict(int)

        async def incr(self, key):
            self.values[key] += 1
            return self.values[key]

        async def expire(self, key, seconds):
            return True

    redis = RedisCounter()
    seen = set()
    delivered = []

    async def request(channel_id, method, path, *, json_body=None, **kwargs):
        body = dict(json_body or {})
        if path.endswith("/files"):
            return {"file_info": "synthetic-image-info"}
        key = (channel_id, body.get("msg_id"), body["msg_seq"])
        is_stream = path.endswith("/stream_messages")
        if not (is_stream and body.get("stream_msg_id")):
            if key in seen:
                raise QQAPIError(method, path, 400, {
                    "code": 40054005,
                    "message": "消息被去重，请检查请求msgseq",
                })
            seen.add(key)
        delivered.append((path, body))
        return {"stream_msg_id": f"synthetic-stream-{len(seen)}"}

    monkeypatch.setattr(outbound.R, "get_redis", lambda: redis)
    monkeypatch.setattr(outbound, "_qq_request", request)
    return delivered


@pytest.mark.parametrize("previous_replies", [0, 5])
async def test_stream_image_and_following_text_do_not_collide(
    qq_reply_transport, previous_replies,
):
    """新计数器与已有流量下，图前文字、PNG、图后文字均成功交付。"""
    for index in range(previous_replies):
        stream = outbound.create_private_text_stream(
            "synthetic-user", channel_id="synthetic-bot",
            message_id=f"previous-inbound-{index}",
        )
        await stream.finish("之前的回复")
    qq_reply_transport.clear()

    before = outbound.create_private_text_stream(
        "synthetic-user", channel_id="synthetic-bot", message_id="inbound-1",
    )
    await before.finish("图前文字")
    assert await outbound.send_file(
        "synthetic-user", b"synthetic-png", "mermaid-diagram", "png",
        "synthetic-bot", "inbound-1",
    ) is True
    after = outbound.create_private_text_stream(
        "synthetic-user", channel_id="synthetic-bot", message_id="inbound-1",
    )
    await after.finish("图后文字")
    assert await outbound.send_c2c(
        "synthetic-user", "补充文字", "inbound-1", "synthetic-bot",
    ) is True

    messages = [
        body for path, body in qq_reply_transport
        if not path.endswith("/stream_messages") or "stream_msg_id" not in body
    ]
    assert len(messages) == 4
    assert len({body["msg_seq"] for body in messages}) == 4
    assert all(body["msg_id"] == "inbound-1" for body in messages)
    for stream in (before, after):
        frames = [body for _, body in qq_reply_transport if body.get("msg_seq") == stream.msg_seq]
        assert [body["input_state"] for body in frames] == [1, 10]


async def test_concurrent_stream_and_image_replies_do_not_collide(qq_reply_transport):
    """独立发送器并发回复同一条入站消息时，也不能占用相同序号。"""
    stream = outbound.create_private_text_stream(
        "synthetic-user", channel_id="synthetic-bot", message_id="inbound-1",
    )
    _, image_sent = await asyncio.gather(
        stream.finish("流式文字"),
        outbound.send_file(
            "synthetic-user", b"synthetic-png", "mermaid-diagram", "png",
            "synthetic-bot", "inbound-1",
        ),
    )
    assert image_sent is True
    assert stream.has_sent()
