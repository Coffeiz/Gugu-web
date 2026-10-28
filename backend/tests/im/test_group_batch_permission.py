"""群批次「一轮一次回复」的身份与提示词约束。

一个批次里同时有主人和群成员的消息时，整轮只回一次，也就只有一个权限主体：
按**最弱**执行——成员消息不借主人权限调用私密工具或读主人私人记忆。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest


def _payload(speakers: list[dict], text: str = "合并的正文") -> dict:
    return {
        "platform": "qq",
        "chat_type": "group",
        "chat_id": "chat-1",
        "channel_id": "bot-1",
        "message_id": "m1",
        "platform_user_id": speakers[-1]["platform_user_id"],
        "platform_user_name": speakers[-1]["platform_user_name"],
        "text": text,
        "_speaker_segments": [
            {
                "platform_user_id": s["platform_user_id"],
                "platform_user_name": s["platform_user_name"],
                "text": s.get("text", ""),
            }
            for s in speakers
        ],
    }


def _access_resolver(mapping: dict[str, tuple[str, list | None]]):
    """按平台 ID 返回 (角色, 工具白名单)；None 白名单表示不限制。"""
    calls: list[str] = []

    async def resolver(platform, chat_type, channel_id, owner_user_id, platform_user_id):
        calls.append(platform_user_id)
        role, tools = mapping[platform_user_id]
        return SimpleNamespace(role=role, allowed_tool_names=tools)

    return resolver, calls


async def test_multi_speaker_batch_runs_with_weakest_role_and_tool_intersection():
    """主人 + 群成员同批：整轮按群成员权限跑，工具白名单取交集。"""
    from agent.im.actor import ActorResolver
    from agent.im.models import PlatformMessage

    resolver, calls = _access_resolver({
        "owner-1": ("owner", None),
        "member-1": ("member", ["read_file", "send_file"]),
    })
    payload = _payload([
        {"platform_user_id": "owner-1", "platform_user_name": "主人"},
        {"platform_user_id": "member-1", "platform_user_name": "群友"},
    ])

    actor = await ActorResolver(access_resolver=resolver).resolve(
        PlatformMessage.from_payload(payload), payload, "owner-uuid"
    )

    assert actor.role == "member"
    assert actor.allowed_tool_names == ["read_file", "send_file"]
    assert actor.is_owner is False
    assert {s["platform_user_id"] for s in actor.speaker_roles} == {"owner-1", "member-1"}
    # 两位发言人都解析过：权限主体不能只按最后一条消息算。
    assert set(calls) == {"owner-1", "member-1"}


async def test_multi_speaker_batch_with_unknown_speaker_falls_back_to_weakest():
    """批里有身份未确认的发言人：整轮按未确认身份处理。"""
    from agent.im.actor import ActorResolver
    from agent.im.models import PlatformMessage

    resolver, _calls = _access_resolver({
        "owner-1": ("owner", None),
        "unknown-1": ("unknown", ["xng_search"]),
    })
    payload = _payload([
        {"platform_user_id": "owner-1", "platform_user_name": "主人"},
        {"platform_user_id": "unknown-1", "platform_user_name": "陌生人"},
    ])

    actor = await ActorResolver(access_resolver=resolver).resolve(
        PlatformMessage.from_payload(payload), payload, "owner-uuid"
    )

    assert actor.role == "unknown"
    assert actor.allowed_tool_names == ["xng_search"]


async def test_missing_speaker_cannot_inherit_owner_permissions():
    """缺少发言人 ID 的消息和 owner 同批时仍按未知身份限制权限。"""
    from agent.im.actor import ActorResolver
    from agent.im.models import PlatformMessage

    resolver, _ = _access_resolver({"owner-1": ("owner", None)})
    payload = _payload([
        {"platform_user_id": "", "platform_user_name": "未知群友"},
        {"platform_user_id": "owner-1", "platform_user_name": "主人"},
    ])
    actor = await ActorResolver(access_resolver=resolver).resolve(
        PlatformMessage.from_payload(payload), payload, "owner-uuid"
    )
    assert actor.role == "unknown"
    assert actor.allowed_tool_names is not None
    assert any(s["role"] == "unknown" for s in actor.speaker_roles)


async def test_single_speaker_batch_keeps_its_own_permissions():
    """只有一位发言人时权限不受影响（主人仍是主人，工具不裁剪）。"""
    from agent.im.actor import ActorResolver
    from agent.im.models import PlatformMessage

    resolver, calls = _access_resolver({"owner-1": ("owner", None)})
    payload = _payload([{"platform_user_id": "owner-1", "platform_user_name": "主人"}])

    actor = await ActorResolver(access_resolver=resolver).resolve(
        PlatformMessage.from_payload(payload), payload, "owner-uuid"
    )

    assert actor.role == "owner"
    assert actor.allowed_tool_names is None
    assert actor.speaker_roles is None
    assert calls == ["owner-1"]


def test_current_content_lists_every_speaker_of_a_merged_round():
    """多发言人时，喂给模型的正文要逐位列出身份，不再声称「都来自当前发言人」。"""
    from agent.im.context_loader import format_current_content
    from agent.models import AgentRequest

    request = AgentRequest(
        message="合并的正文",
        user_id="owner-uuid",
        user_name="主人",
        source="qq",
        chat_id="chat-1",
        platform_user_id="member-1",
        platform_user_name="群友",
        im_role="member",
        im_turn_speakers=[
            {"platform_user_id": "owner-1", "platform_user_name": "主人", "role": "owner"},
            {"platform_user_id": "member-1", "platform_user_name": "群友", "role": "member"},
        ],
    )

    rendered = format_current_content("【主人】在吗\n【群友】?", request)

    assert "平台身份=owner-1" in rendered
    assert "平台身份=member-1" in rendered
    assert "权限角色=绑定用户 owner" in rendered
    assert "权限角色=群成员 member" in rendered
    assert "一定来自这位当前发言人" not in rendered
    assert "【主人】在吗" in rendered


def test_current_content_keeps_single_speaker_anchor():
    """单发言人时锚点措辞不变（提示词逐字稳定，缓存前缀不受影响）。"""
    from agent.im.context_loader import format_current_content
    from agent.models import AgentRequest

    request = AgentRequest(
        message="在吗",
        user_id="owner-uuid",
        user_name="主人",
        source="qq",
        chat_id="chat-1",
        platform_user_id="owner-1",
        platform_user_name="主人",
        im_role="owner",
    )

    rendered = format_current_content("在吗", request)

    assert "一定来自这位当前发言人" in rendered
    assert "平台身份=owner-1" in rendered


def test_identity_block_marks_merged_round_as_weakest_permission():
    """身份事实块要说明这一轮有多位发言人、整轮按最弱权限执行。"""
    from agent.im.context_runtime import im_identity_block
    from agent.models import AgentRequest

    request = AgentRequest(
        message="合并的正文",
        user_id="owner-uuid",
        user_name="主人",
        source="qq",
        chat_id="chat-1",
        platform_user_id="member-1",
        platform_user_name="群友",
        im_role="member",
        im_turn_speakers=[
            {"platform_user_id": "owner-1", "platform_user_name": "主人", "role": "owner"},
            {"platform_user_id": "member-1", "platform_user_name": "群友", "role": "member"},
        ],
    )

    block = im_identity_block(request, [])

    assert "本轮合并了 2 位发言人的消息" in block
    assert "整轮权限按最弱的一位（群成员）执行" in block
    assert "本轮发言人：平台身份=owner-1" in block
    assert "本轮发言人：平台身份=member-1" in block
    assert "只能使用各自的身份和资料" in block
