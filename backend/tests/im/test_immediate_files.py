"""IM 文件即时投递：真实回执、并发去重与不明状态不得重发。"""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest

from agent.im.immediate_files import ImmediateFileDelivery


class RedisLedger:
    def __init__(self):
        self.values = {}

    async def set(self, key, value, *, nx=False, ex=None):
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True

    async def get(self, key):
        return self.values.get(key)


def payload(**values):
    return {"platform": "qq", "channel_id": "test-bot", "platform_user_id": "test-user",
            "chat_type": "c2c", "message_id": "test-message", "owner_user_id": "test-owner", **values}


@pytest.fixture
def ledger(monkeypatch):
    from app.core import redis as redis_core
    db = RedisLedger()
    monkeypatch.setattr(redis_core, "get_redis", lambda: db)
    return db


@pytest.mark.asyncio
async def test_concurrent_same_message_and_file_sent_once(ledger, monkeypatch):
    from agent.im import files
    send = AsyncMock(return_value=SimpleNamespace(all_sent=True))
    monkeypatch.setattr(files, "send_files", send)
    delivery = ImmediateFileDelivery(payload())
    assert await asyncio.gather(delivery({"file_id": 42}), delivery({"file_id": 42})) == ["sent", "sent"]
    send.assert_awaited_once()
    assert send.await_args.args[0]["message_id"] is None


@pytest.mark.asyncio
async def test_uuid_owner_uses_stable_delivery_key(ledger, monkeypatch):
    from agent.im import files
    send = AsyncMock(return_value=SimpleNamespace(all_sent=True))
    monkeypatch.setattr(files, "send_files", send)
    owner = UUID("00000000-0000-0000-0000-000000000001")
    assert await ImmediateFileDelivery(payload(owner_user_id=owner))({"file_id": 42}) == "sent"
    assert await ImmediateFileDelivery(payload(owner_user_id=str(owner)))({"file_id": 42}) == "sent"
    send.assert_awaited_once()


@pytest.mark.asyncio
async def test_unknown_delivery_is_not_retried(ledger, monkeypatch):
    from agent.im import files
    send = AsyncMock(return_value=SimpleNamespace(all_sent=False, unconfirmed=True))
    monkeypatch.setattr(files, "send_files", send)
    delivery = ImmediateFileDelivery(payload())
    assert await delivery({"file_id": 42}) == "unknown"
    assert await ImmediateFileDelivery(payload())({"file_id": 42}) == "unknown"
    send.assert_awaited_once()


@pytest.mark.asyncio
async def test_confirmed_preflight_failure_is_returned_without_retry(ledger, monkeypatch):
    from agent.im import files
    send = AsyncMock(return_value=SimpleNamespace(all_sent=False, unconfirmed=False))
    monkeypatch.setattr(files, "send_files", send)
    delivery = ImmediateFileDelivery(payload())
    assert await delivery({"file_id": 42}) == "failed"
    assert await delivery({"file_id": 42}) == "failed"
    send.assert_awaited_once()


@pytest.mark.asyncio
async def test_platform_rejection_overrides_generic_unconfirmed_result(ledger, monkeypatch):
    from agent.im import files

    async def send(payload, artifacts):
        payload["_im_file_receipt"]["state"] = "failed"
        return SimpleNamespace(all_sent=False, unconfirmed=True)

    monkeypatch.setattr(files, "send_files", send)
    assert await ImmediateFileDelivery(payload())({"file_id": 42}) == "failed"


@pytest.mark.asyncio
async def test_cancelled_upload_remains_unconfirmed_and_is_not_retried(ledger, monkeypatch):
    from agent.im import files
    send = AsyncMock(side_effect=asyncio.CancelledError())
    monkeypatch.setattr(files, "send_files", send)
    delivery = ImmediateFileDelivery(payload())
    with pytest.raises(asyncio.CancelledError):
        await delivery({"file_id": 42})
    assert await ImmediateFileDelivery(payload())({"file_id": 42}) == "unknown"
    send.assert_awaited_once()


@pytest.mark.asyncio
async def test_group_without_mention_is_deferred(ledger, monkeypatch):
    from agent.im import files
    send = AsyncMock()
    monkeypatch.setattr(files, "send_files", send)
    delivery = ImmediateFileDelivery(payload(chat_type="group", group_mentioned=False))
    assert await delivery({"file_id": 42}) == "deferred"
    assert ledger.values == {}
    send.assert_not_awaited()


@pytest.mark.asyncio
async def test_group_mention_waits_for_stream_boundary(ledger, monkeypatch):
    from agent.im import files
    boundary = SimpleNamespace(before_platform_event=AsyncMock(return_value=False))
    send = AsyncMock()
    monkeypatch.setattr(files, "send_files", send)
    delivery = ImmediateFileDelivery(payload(chat_type="group", group_mentioned=True), boundary=boundary)
    assert await delivery({"file_id": 42}) == "unknown"
    boundary.before_platform_event.assert_awaited_once()
    send.assert_not_awaited()


@pytest.mark.asyncio
async def test_finalization_skips_sent_and_unknown_artifacts(monkeypatch):
    from agent.im import files
    send = AsyncMock()
    monkeypatch.setattr(files, "send_file", send)
    result = await files.send_files(payload(), [
        {"file_id": 42, "_im_delivery_state": "sent"},
        {"file_id": 43, "_im_delivery_state": "unknown"},
    ])
    assert (result.requested, result.sent, result.failed) == (2, 1, 1)
    assert "未确认" in result.reason
    send.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("delivery_state", ["sent", "unknown", "failed"])
async def test_tool_returns_real_delivery_result_and_marks_artifact(monkeypatch, delivery_state):
    import json
    from agent.im import imctx
    from agent.tools.base import SkillRegistry, Tool

    async def prepare(_db, _user, _args):
        return {"ok": True, "message": "已准备", "_artifact": {"file_id": 42}}

    registry = SkillRegistry()
    registry.add(Tool(name="send_file", description="测试", input_schema={"type": "object"}, handler=prepare))
    imctx.set_im("qq", "test-message", "test-bot", None, puid="test-user", chat_type="c2c")
    deliver = AsyncMock(return_value=delivery_state)
    imctx.get_im()["immediate_file_delivery"] = deliver
    try:
        result, artifact = await registry.dispatch("test-owner", "send_file", {})
    finally:
        imctx.clear()
    parsed = json.loads(result)
    assert parsed["delivery_status"] == delivery_state
    assert parsed["ok"] is (delivery_state == "sent")
    assert artifact["_im_delivery_state"] == delivery_state
    deliver.assert_awaited_once()
