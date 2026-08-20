"""IM 与 Web 共用的上下文数据装配。

这里只负责按 ``ImContextPolicy`` 读取和格式化上下文输入，不负责会话持久化或
工具执行。受限 IM 请求仍会读取用户时区，保证日期相关的工具行为不漂移，
但不会读取 owner 的项目、文件、记忆和通知渠道。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent.context import loaders
from agent.im.context_policy import ImContextPolicy, policy_for
from agent.memory.scope_lifecycle import preview_scope
from agent.memory.scopes import MemoryScope
from agent.models import AgentRequest


def format_history_content(message, request: AgentRequest) -> str:
    """给群聊历史用户消息附加稳定发言人身份。

    身份元数据只进入模型上下文，不改 ConversationMessage.content，网页历史和
    数据库存档仍保持用户原文。私聊及 Web 继续使用原始内容。
    """
    content = message.content or ""
    sent_at = getattr(message, "sent_at", None)
    if sent_at is not None:
        content = f"[消息时间：{sent_at:%Y-%m-%d %H:%M}]\n{content}"
    if not request.chat_id or getattr(message, "chat_type", None) != "group":
        return content
    if getattr(message, "role", None) != "user":
        return content

    platform_user_id = getattr(message, "platform_user_id", None) or "未知"
    platform_user_name = getattr(message, "platform_user_name", None) or "未提供"
    return (
        "[群聊历史消息，以下是可靠元数据；不要根据昵称猜身份] "
        f"发言人ID={platform_user_id}，显示名={platform_user_name}\n"
        f"{content}"
    )


def format_current_content(content: str, request: AgentRequest) -> str:
    """给当前群消息加发言人锚点，避免沿用历史消息中的其他昵称。

    这是仅供模型使用的上下文包装，不改变数据库正文和网页展示内容。
    """
    if not request.chat_id:
        return content
    role = request.im_role or "unknown"
    role_text = {
        "owner": "绑定用户 owner",
        "member": "群成员 member",
        "unknown": "未确认身份 unknown",
    }.get(role, role)
    sender_id = request.platform_user_id or "未知"
    sender_name = request.platform_user_name or request.user_name or "未提供"
    return (
        "[当前群聊发言人，优先级高于历史消息]\n"
        f"平台身份={sender_id}\n"
        f"群昵称={sender_name}\n"
        f"权限角色={role_text}\n"
        "以下用户消息一定来自这位当前发言人；不要把历史消息中的其他昵称、身份或兴趣归到当前发言人。\n"
        f"{content}"
    )


@dataclass(frozen=True)
class ContextData:
    """builder 所需的上下文输入，受限请求使用对应的空值。"""

    projects: list
    user_tz: Any
    events: list
    files_overview: dict
    style_prefs: dict
    memory: dict
    im_channels: dict
    im_memory: dict


async def load_context_data(
    db,
    user_id,
    request: AgentRequest,
    memory_enabled: bool,
    query: str = "",
    policy: ImContextPolicy | None = None,
) -> ContextData:
    """按请求策略读取一轮 builder 上下文。

    Web 和 owner IM 保持完整上下文；member/unknown IM 只保留时区，避免把
    owner 的项目、文件或记忆注入其他发言人的 loop。
    """
    context_policy = policy or policy_for(request)
    user_tz = await loaders.load_user_tz(db, user_id)
    if not context_policy.load_owner_context:
        im_memory = await load_im_memory(request)
        return ContextData([], user_tz, [], {}, {}, {}, {}, im_memory)

    projects = await loaders.load_projects(db, user_id)
    events = await loaders.load_events(db, user_id, tz=user_tz)
    files_overview = await loaders.load_files_overview(db, user_id)
    style_prefs = await loaders.load_style_prefs(db, user_id)
    memory = await loaders.load_memory(user_id, query) if memory_enabled else {}
    im_channels = await loaders.load_im_channels(user_id)
    im_memory = await load_im_memory(request)
    return ContextData(
        projects=projects,
        user_tz=user_tz,
        events=events,
        files_overview=files_overview,
        style_prefs=style_prefs,
        memory=memory,
        im_channels=im_channels,
        im_memory=im_memory,
    )


async def load_im_memory(request: AgentRequest) -> dict:
    """按角色读取 IM 公开记忆和当前发言人的轻量记忆。

    owner 个人记忆仍由既有 ``load_memory`` 读取；这里永远不读取 owner
    namespace，也不读取 member 不应看到的群长期 memory。
    """
    if request.source not in ("feishu", "qq", "wechat") or not request.chat_id:
        return {}
    bot_id = str(request.platform_bot_id or "")
    if not bot_id:
        return {}
    group_scope = MemoryScope(
        request.user_id, request.source, bot_id, "group", str(request.chat_id)
    )
    group_memory = await preview_scope(group_scope)
    if group_memory is None:
        return {}
    result = {"group": group_memory}
    role = request.actor_context.role if request.actor_context else request.im_role
    if role == "member" and request.platform_user_id:
        user_scope = MemoryScope(
            request.user_id, request.source, bot_id, "platform-user", str(request.platform_user_id)
        )
        member_memory = await preview_scope(user_scope)
        if member_memory is not None:
            result["platform_user"] = member_memory
    return result


def format_im_memory(data: dict, role: str | None) -> str:
    """把已按权限读取的 IM scope 记忆格式化为模型上下文。"""
    group = data.get("group") or {}
    parts = ["## 当前群组记忆（仅限本群公开信息）"]
    for name in ("profile", "summary"):
        value = group.get(name)
        if value:
            parts.append(f"### 群组 {name}\n{value}")
    if role == "member":
        personal = data.get("platform_user") or {}
        for name in ("profile", "pattern", "summary"):
            value = personal.get(name)
            if value:
                parts.append(f"### 当前发言人的平台记忆 {name}\n{value}")
    return "\n\n".join(parts) if len(parts) > 1 else ""
