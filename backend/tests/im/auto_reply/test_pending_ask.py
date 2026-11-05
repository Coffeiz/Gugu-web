"""延迟 ASK 的原始事件锚点和原生回复取消边界。"""
import json

import pytest

from agent.im.auto_reply import pending_ask


class _RedisProbe:
    def __init__(self):
        self.calls = []

    async def eval(self, script, numkeys, *args):
        self.calls.append((script, numkeys, args))
        return 1


@pytest.mark.asyncio
async def test_pending_ask_payload_contains_only_the_scored_trigger(monkeypatch):
    redis = _RedisProbe()
    monkeypatch.setattr(pending_ask.R, "get_redis", lambda: redis)
    payload = {
        "platform": "qq", "channel_id": "bot-1", "chat_id": "group-1",
        "chat_type": "group", "owner_user_id": "owner-1", "session_id": 7,
        "_batch_messages": [
            {
                "event_id": "1761746400000-1", "text": "@someone 这个 fork 是你的吗？",
                "platform_user_id": "member-a", "platform_message_id": "platform-1",
            },
            {
                "event_id": "1761746401000-2", "text": "为啥没有 issue？",
                "platform_user_id": "owner-1", "platform_user_name": "主人",
                "platform_message_id": "platform-2", "attachments": [],
            },
        ],
        "_speaker_segments": [
            {"event_id": "1761746400000-1", "platform_user_id": "member-a"},
            {"event_id": "1761746401000-2", "platform_user_id": "owner-1"},
        ],
    }

    result = await pending_ask.register_pending_ask(
        payload, event_ms=1761746401000, session_id=7,
        trigger_event_id="1761746401000-2",
    )

    assert result is not None
    _script, numkeys, args = redis.calls[0]
    assert numkeys == 3
    stored = json.loads(args[5])
    assert [item["event_id"] for item in stored["_batch_messages"]] == ["1761746401000-2"]
    assert stored["text"] == "为啥没有 issue？"
    assert stored["platform_user_id"] == "owner-1"
    assert [item["platform_user_id"] for item in stored["_speaker_segments"]] == ["owner-1"]
    assert stored["_pending_ask_trigger_event_id"] == "1761746401000-2"
    assert stored["_pending_ask_trigger_platform_message_id"] == "platform-2"

    # 混合批次恢复后，只以 Owner 的 ASK 计算权限，不再被成员消息降级。
    from agent.im.actor import ActorResolver
    from agent.im.models import PlatformMessage
    from types import SimpleNamespace

    async def access_resolver(platform, chat_type, channel_id, owner_user_id, platform_user_id):
        return SimpleNamespace(
            role="owner" if platform_user_id == "owner-1" else "member",
            allowed_tool_names=None,
        )

    actor = await ActorResolver(access_resolver=access_resolver).resolve(
        PlatformMessage.from_payload(stored), stored, "owner-uuid",
    )
    assert actor.role == "owner"


@pytest.mark.asyncio
async def test_group_activity_passes_native_reply_target_for_atomic_pending_cancel(monkeypatch):
    redis = _RedisProbe()
    monkeypatch.setattr(pending_ask.R, "get_redis", lambda: redis)
    payload = {
        "platform": "qq", "channel_id": "bot-1", "chat_id": "group-1",
        "owner_user_id": "owner-1", "platform_bot_user_id": "bot-user",
        "_batch_messages": [{
            "event_id": "1761746402000-3", "platform_user_id": "member-c",
            "reply_to_platform_message_id": "platform-2",
        }],
    }

    await pending_ask.observe_group_activity(payload)

    _script, numkeys, args = redis.calls[0]
    assert numkeys == 4
    assert args[-2:] == ("member-c", "platform-2")
    assert "trigger_platform_message_id" in _script
