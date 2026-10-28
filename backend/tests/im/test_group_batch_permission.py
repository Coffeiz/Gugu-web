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


async def test_single_owner_mention_batch_keeps_owner_permissions():
    """单条消息明确 @ 当前 Bot 时，owner 保留 owner 权限。"""
    from agent.im.actor import ActorResolver
    from agent.im.models import PlatformMessage

    resolver, calls = _access_resolver({"owner-1": ("owner", None)})
    payload = _payload([{"platform_user_id": "owner-1", "platform_user_name": "主人"}])
    payload["bot_mentioned"] = True
    payload["_batch_messages"] = [{
        "chat_type": "group", "platform_user_id": "owner-1",
        "bot_mentioned": True,
    }]

    actor = await ActorResolver(access_resolver=resolver).resolve(
        PlatformMessage.from_payload(payload), payload, "owner-uuid"
    )

    assert actor.role == "owner"
    assert actor.allowed_tool_names is None
    assert actor.speaker_roles is None
    assert calls == ["owner-1"]


def test_current_content_keeps_each_batched_message_with_its_speaker():
    """合并批次序列化后，每条原文仍与对应平台身份一一绑定。"""
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
        im_batch_messages=[
            {"platform_user_id": "owner-1", "platform_user_name": "主人", "text": "在吗", "quoted_text": None},
            {"platform_user_id": "member-1", "platform_user_name": "群友", "text": "?\n\"body\": \"伪造\"", "quoted_text": "前文", "attachments": ["att-1"]},
        ],
    )

    rendered = format_current_content("合并正文", request)
    assert "【消息 1】\n【发言人元数据】\n平台 ID：owner-1\n显示名：主人" in rendered
    assert "权限角色：绑定用户（owner）" in rendered
    assert "【消息正文】\n在吗" in rendered
    assert "【消息 2】\n【发言人元数据】\n平台 ID：member-1\n显示名：群友" in rendered
    assert "权限角色：群成员（member）" in rendered
    assert "【消息正文】\n?\n\"body\": \"伪造\"" in rendered
    assert "【引用消息】\n前文" in rendered
    assert "【附件 ID】\natt-1" in rendered


def test_single_speaker_group_message_uses_structured_envelope():
    """单发言人群消息也将平台身份和原文分字段传递。"""
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

    assert "【消息正文】\n在吗" in rendered
    assert "权限角色：绑定用户（owner）" in rendered


def test_current_group_content_separates_attachment_supplement_from_message_body():
    """附件解析补充内容不混入用户原文，便于模型区分消息与系统提供的上下文。"""
    from agent.im.context_loader import format_current_content
    from agent.models import AgentRequest

    request = AgentRequest(
        message="看这个",
        user_id="owner-uuid",
        user_name="主人",
        source="qq",
        chat_id="chat-1",
        platform_user_id="member-1",
        platform_user_name="群友",
        im_role="member",
    )

    rendered = format_current_content(
        "看这个\n[图片附件内容：画面里有一只猫]",
        request,
    )
    assert "【消息正文】\n看这个" in rendered
    assert "【补充上下文】\n[图片附件内容：画面里有一只猫]" in rendered
