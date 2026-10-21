"""IM 身份、权限快照与 AgentRequest 准备。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Optional

from agent.im.actor import ActorContext, ActorResolver
from agent.im.context_policy import IM_SOURCES
from agent.im.identity import resolve_owner_account
from agent.im.models import PlatformMessage
from agent.im.owner_session import bind_session_by_id, resolve_session as resolve_owner_session
from agent.im.permissions import resolve_access
from agent.im.session import SessionRoute, get_session, resolve_route, resolve_session_id, set_session
from agent.models import AgentRequest


@dataclass(frozen=True)
class PreparedImRequest:
    """一次 IM 请求的身份和权限快照。"""

    request: AgentRequest
    actor: ActorContext
    role: Optional[str]
    allowed_tool_names: Optional[List[str]]
    session_route: SessionRoute
    session_id: Optional[int]


async def prepare_message(payload: dict, platform_message: PlatformMessage) -> Optional[PreparedImRequest]:
    """完成 Gateway payload 到 AgentRequest 的完整身份准备。"""
    identity = await resolve_owner_account(payload)
    if identity is None:
        return None
    route = resolve_route(platform_message, payload)
    if route.is_group:
        session_id = await resolve_session_id(
            platform_message.platform or "worker",
            route,
            payload.get("session_id"),
            getter=get_session,
        )
    else:
        session_id = await resolve_owner_session(
            identity.user_id,
            platform_message.platform or "worker",
            platform_message.sender.id or payload.get("platform_user_id") or "",
            payload.get("session_id"),
            route.bot_id,
        )
    return await prepare_request(
        platform_message,
        payload,
        identity.user_id,
        identity.user_name,
        session_route=route,
        session_id=session_id,
    )


async def prepare_request(
    platform_message: PlatformMessage,
    payload: dict,
    owner_user_id,
    user_name: str,
    session_route: Optional[SessionRoute] = None,
    session_id: Optional[int] = None,
) -> PreparedImRequest:
    """解析 IM 权限并构造共享 AgentRequest。

    权限解析失败时固定降级为 unknown + xng_search/web_search，绝不因异常把当前发言人
    升级成 owner。显示名仍由 identity 门面按角色裁剪后传入。
    """
    route = session_route or resolve_route(platform_message, payload)
    actor = await ActorResolver(access_resolver=resolve_access).resolve(
        platform_message, payload, owner_user_id
    )
    platform = actor.platform
    platform_user_id = actor.platform_user_id
    chat_type = actor.chat_type
    role = actor.role
    allowed_tool_names = actor.allowed_tool_names
    from agent.im.permissions import resolve_group_owner_memory
    group_owner_memory = await resolve_group_owner_memory(actor, route.bot_id)
    agent_user_name = (
        payload.get("platform_user_name") or platform_message.sender.name or "这位群友"
        if role in {"member", "unknown"}
        else user_name
    )
    request = AgentRequest(
        message=payload.get("text", ""),
        user_id=owner_user_id,
        user_name=agent_user_name,
        session_id=session_id,
        chat_id=platform_message.chat.id if chat_type == "group" else None,
        platform_user_id=platform_user_id,
        platform_bot_id=route.bot_id,
        platform_user_name=payload.get("platform_user_name"),
        platform_bot_user_id=payload.get("platform_bot_user_id"),
        source=platform,
        attachments=payload.get("attachments") or [],
        quoted_text=payload.get("quoted_text"),
        im_role=role,
        allowed_tool_names=allowed_tool_names,
        actor_context=actor,
        im_message_format=payload.get("message_format"),
        im_group_memory_enabled=bool(payload.get("group_memory_enabled", True)),
        im_member_memory_enabled=bool(payload.get("member_memory_enabled", True)),
        im_group_owner_memory_enabled=group_owner_memory,
    )
    return PreparedImRequest(request, actor, role, allowed_tool_names, route, session_id)


def _should_observe_private_member_activity(request: AgentRequest) -> bool:
    """私聊平台用户记忆只属于成员；owner 由统一 owner 反思链路处理。"""
    return bool(
        request.im_role == "member"
        and not request.chat_id
        and request.im_member_memory_enabled
        and request.platform_user_id
    )


async def _ensure_im_session(request: AgentRequest) -> int:
    """在 IM run 启动前解析会话，保证 Web 镜像有稳定的 session id。

    Redis 路由缓存可能过期；Runner 虽会在持久化阶段从数据库复用会话，
    但那时 Web 的 genstream 已经错过 begin 和 running 通知。
    """
    if request.session_id:
        return int(request.session_id)

    import app.db.session as db_session
    from agent.im.session import get_or_create_session

    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        state = await get_or_create_session(db, request, request.user_id)
        await db.commit()
    request.session_id = int(state.session.id)
    return request.session_id
