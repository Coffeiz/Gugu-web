"""IM Loop 的请求准备门面。

这里先收口“平台消息 → ActorContext → AgentRequest”这一段，不复制模型循环。
worker 仍负责 Redis 消费、被动群消息、命令/intent shortcut 的执行和平台发送；
后续阶段再把 owner/member 的完整调用流程迁入这里。
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any, List, Optional

from app.core.redaction import diag_log, redact
from agent.im.actor import ActorContext
from agent.im.context_policy import IM_SOURCES
from agent.im.identity import resolve_owner_account
from agent.im.models import PlatformMessage
from agent.im.owner_session import (
    bind_session_by_id,
    resolve_session as resolve_owner_session,
)
from agent.im.permissions import resolve_access
from agent.im.session import (
    SessionRoute,
    get_session,
    resolve_route,
    resolve_session_id,
    set_session,
    trim_group_messages,
)
from agent.models import AgentRequest


# 即时反馈只负责体验层，不决定是否进入 Agent、身份和权限。
_QUICK_REACTION_RULES = [
    ("LAUGH", ("哈哈", "草", "笑死了", "哈哈哈"), ("哈哈", "23333", "笑死", "草", "lol", "hhh", "😂", "🤣")),
    ("THANKS", ("客气啦~", "嗨这没事", "应该的~"), ("谢谢", "多谢", "感谢", "辛苦", "thx", "thanks", "🙏")),
    ("DONE", ("漂亮~", "棒", "搞定收工"), ("搞定", "完成", "好了", "弄好", "done", "成了", "通过了")),
    ("WOW", ("哇厉害", "牛啊", "可以的~"), ("厉害", "牛", "强", "哇", "wow", "卧槽", "666", "绝了")),
    ("CRY", ("唉别难过", "抱抱", "心疼一下"), ("难过", "可惜", "唉", "崩溃", "麻了", "心疼", "emo", "😭", "😢")),
    ("PARTY", ("恭喜恭喜!", "庆祝一下~", "太棒了!"), ("恭喜", "庆祝", "上线", "发布", "纪念", "🎉")),
    ("OnIt", ("嗨~", "在呢", "诶到~"), ("你好", "在吗", "在不在", "早", "晚上好", "中午好", "hi", "hello")),
    ("THINKING", ("让我想想哈~", "我看看哈", "稍等想一下"), ("为什么", "怎么", "如何", "?", "？", "吗", "呢", "请问", "能不能", "可不可以")),
]
_QUICK_DEFAULT = ("OnIt", ("在看~", "收到,马上", "看看哈~", "嗯嗯我瞧瞧"))
_QUICK_MEDIA = ("收到,我看看~", "文件到了,瞅瞅", "收到啦~")


def choose_instant_reaction(text: str, has_media: bool) -> tuple[str, str]:
    """选择体验层即时反馈；不触发 Agent，也不参与权限和业务决策。"""
    if has_media:
        return random.choice(_QUICK_MEDIA), "OnIt"
    normalized = (text or "").lower()
    for emoji, replies, keywords in _QUICK_REACTION_RULES:
        if any(keyword in normalized for keyword in keywords):
            return random.choice(replies), emoji
    return random.choice(_QUICK_DEFAULT[1]), _QUICK_DEFAULT[0]


@dataclass(frozen=True)
class PreparedImRequest:
    """一次 IM 请求的身份和权限快照。"""

    request: AgentRequest
    actor: ActorContext
    role: Optional[str]
    allowed_tool_names: Optional[List[str]]
    session_route: SessionRoute
    session_id: Optional[int]


@dataclass(frozen=True)
class ImActivity:
    """一次 IM 模型执行期间的忙碌态和平台 typing 句柄。"""

    platform: str
    platform_user_id: str
    typing_indicator: Any


class OwnerAgentLoop:
    """Web/owner IM 共用的完整 Agent Loop 门面。"""

    async def run_collect(self, request: AgentRequest):
        from agent.runner import run_collect
        return await run_collect(request)

    def run_stream(self, request: AgentRequest):
        from agent.runner import run_stream
        return run_stream(request)


class MemberAgentLoop(OwnerAgentLoop):
    """member/unknown 的轻量入口，权限和上下文由 request policy 收紧。"""


async def decide_im_shortcut(
    platform: str,
    platform_user_id: str,
    text: str,
    *,
    has_attachments: bool = False,
) -> dict:
    """根据当前 IM 状态判断是否需要在入队前短路。"""
    if has_attachments:
        return {"action": "run"}
    from agent import router, runtime_state

    return router.decide(
        text,
        await runtime_state.get_state(platform, platform_user_id),
        await runtime_state.is_awaiting(platform, platform_user_id),
    )


def decide_im_shortcut_sync(
    platform: str,
    platform_user_id: str,
    text: str,
    *,
    has_attachments: bool = False,
) -> dict:
    """同步 Gateway 回调使用的 intent shortcut 决策。"""
    if has_attachments:
        return {"action": "run"}
    from agent import router, runtime_state

    return router.decide(
        text,
        runtime_state.get_state_sync(platform, platform_user_id),
        runtime_state.is_awaiting_sync(platform, platform_user_id),
    )


async def apply_im_shortcut_cancel(platform: str, platform_user_id: str, decision: dict) -> None:
    """执行短路决策中的取消动作，状态修改仍归 IM Loop。"""
    if decision.get("action") == "cancel":
        from agent import runtime_state
        await runtime_state.request_cancel(platform, platform_user_id)


def apply_im_shortcut_cancel_sync(platform: str, platform_user_id: str, decision: dict) -> None:
    """同步 Gateway 回调使用的取消动作。"""
    if decision.get("action") == "cancel":
        from agent import runtime_state
        runtime_state.request_cancel_sync(platform, platform_user_id)


async def start_im_activity(payload: dict, platform: str, platform_user_id: str) -> ImActivity:
    """设置 IM 忙碌态，并启动平台支持的 typing 指示器。"""
    from agent import runtime_state
    from agent.gateway import wechat

    await runtime_state.set_state(platform, platform_user_id, runtime_state.THINKING)
    typing_indicator = await wechat.start_typing(payload)
    return ImActivity(platform, platform_user_id, typing_indicator)


async def finish_im_activity(activity: ImActivity) -> None:
    """无论模型成功、失败或取消，都清理忙碌态和 typing 指示器。"""
    from agent import runtime_state
    from agent.gateway import wechat

    await runtime_state.clear_state(activity.platform, activity.platform_user_id)
    await runtime_state.clear_cancel(activity.platform, activity.platform_user_id)
    await wechat.stop_typing(activity.typing_indicator)


async def remember_im_reach(
    user_id,
    platform: str,
    payload: dict,
    platform_user_id: Optional[str],
) -> None:
    """记录平台可触达地址，供定时任务和主动通知复用。"""
    from app import scheduled_tasks

    try:
        await scheduled_tasks.save_imreach(
            user_id,
            platform,
            payload.get("channel_id"),
            payload.get("chat_id"),
            platform_user_id,
            payload.get("context_token", ""),
        )
    except Exception:
        # 可触达地址是 best-effort 状态，写入失败不能影响当前对话。
        pass


def bind_im_context(request: AgentRequest, payload: dict) -> None:
    """把当前请求的 IM 路由和权限快照绑定到工具侧 ContextVar。"""
    from agent import imctx

    imctx.set_im(
        request.source,
        payload.get("message_id"),
        payload.get("channel_id"),
        request.chat_id,
        request.platform_user_id,
        payload.get("chat_type"),
        payload.get("context_token", ""),
        request.allowed_tool_names,
        request.im_role,
    )


async def finalize_im_response(platform: str, platform_user_id: str,
                               cancelled: bool, reply_text: str) -> None:
    """根据 IM 回复结果更新是否等待用户继续回答的状态。"""
    from agent import router, runtime_state

    if cancelled:
        await runtime_state.set_awaiting(platform, platform_user_id, False)
        return
    await runtime_state.set_awaiting(
        platform,
        platform_user_id,
        router.reply_awaits_answer(reply_text),
    )


async def handle_im_command(user_id, message: str) -> Optional[str]:
    """处理不需要模型的 IM 命令，返回回复文本或 ``None``。"""
    from agent import commands

    return await commands.handle(user_id, message)


async def record_passive_im_message(request: AgentRequest, session_id: Optional[int] = None) -> int:
    """保存未触发回复的群消息，供后续 @ 咕咕时读取同一会话上下文。"""
    import app.db.session as db_session
    from app.models import ConversationMessage, ConversationSession

    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        session = await db.get(ConversationSession, session_id) if session_id else None
        if session is not None and (
            session.user_id != request.user_id
            or session.source != (request.source or "qqbot")
            or session.bot_id != request.platform_bot_id
            or session.chat_id != request.chat_id
        ):
            # Redis 路由异常或旧 key 不得把消息写进另一个 Bot/群的会话。
            session = None
        if session is None:
            session = ConversationSession(
                user_id=request.user_id,
                title=(request.message[:50] or "群聊记录"),
                source=request.source or "qqbot",
                bot_id=request.platform_bot_id,
                chat_id=request.chat_id,
                chat_type=("group" if request.chat_id else
                           "c2c" if request.source in IM_SOURCES else None),
            )
            db.add(session)
            await db.flush()
        db.add(ConversationMessage(
            session_id=session.id,
            role="user",
            content=request.message,
            quoted_text=request.quoted_text,
            platform_user_id=request.platform_user_id,
            platform_user_name=request.platform_user_name,
            platform_bot_user_id=request.platform_bot_user_id,
            chat_type=("group" if request.chat_id else
                       "c2c" if request.source in IM_SOURCES else None),
        ))
        await db.commit()
        await trim_group_messages(session.id)
        # 被动群消息不经过 runner，单独补发会话增量，网页才能实时看到这条已记录消息。
        try:
            from app.core import events

            await events.publish(
                request.user_id,
                "sessions",
                session_id=session.id,
                appended=[{
                    "role": "user",
                    "text": request.message,
                    "platform_user_id": request.platform_user_id,
                    "platform_user_name": request.platform_user_name,
                    "platform_bot_user_id": request.platform_bot_user_id,
                    "chat_type": "group",
                }],
            )
        except Exception:
            pass
        return session.id


def should_record_passive_group(request: AgentRequest, payload: dict) -> bool:
    """判断是否为 QQ 群静默记录模式；该模式对所有消息都不触发回复。"""
    return bool(
        request.source == "qqbot"
        and request.chat_id
        and payload.get("chat_type") == "group"
        and payload.get("group_read_enabled")
    )


async def persist_im_session(
    platform: str,
    bot_id: str,
    scope_id: str,
    session_id: Optional[int],
    *,
    group: bool = False,
) -> None:
    """写回 IM 路由 session，并在群聊路径统一执行消息窗口裁剪。"""
    if group:
        await set_session(platform, bot_id, scope_id, session_id)
        if session_id:
            await trim_group_messages(session_id)
        return
    # 私聊读取的是 owner-session 绑定，不能再写入旧的通用 imsession key。
    # 这里由 session 记录反查其用户归属，避免从平台字段重新推断 owner。
    await bind_session_by_id(platform, scope_id, session_id, bot_id)


# 旧测试和外部诊断脚本使用的名称，实际实现归属 IM Loop。
trim_group_session_messages = trim_group_messages


def select_loop(request: AgentRequest) -> OwnerAgentLoop:
    """根据 ActorContext 选择门面，不复制模型或工具执行循环。"""
    if request.actor_context is not None:
        restricted = request.actor_context.is_restricted
    else:
        restricted = request.im_role in {"member", "unknown"}
    return MemberAgentLoop() if restricted else OwnerAgentLoop()


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

    权限解析失败时固定降级为 unknown + web_search，绝不因异常把当前发言人
    升级成 owner。显示名仍由 identity 门面按角色裁剪后传入。
    """
    platform = platform_message.platform or "worker"
    route = session_route or resolve_route(platform_message, payload)
    platform_user_id = platform_message.sender.id or payload.get("platform_user_id")
    chat_type = platform_message.chat.type or payload.get("chat_type")
    role = None
    allowed_tool_names = None
    if platform in IM_SOURCES:
        try:
            access = await resolve_access(
                platform,
                chat_type,
                payload.get("channel_id") or platform_message.bot_id,
                owner_user_id,
                platform_user_id or "",
            )
            role = access.role or "unknown"
            allowed_tool_names = access.allowed_tool_names
            if role == "unknown" and allowed_tool_names is None:
                allowed_tool_names = ["web_search"]
        except Exception as exc:
            diag_log("im.prepare_access", exc)
            print(
                f"[im] {platform} 身份权限解析失败，按最小权限继续: {redact(type(exc).__name__)}",
                flush=True,
            )
            role = "unknown"
            allowed_tool_names = ["web_search"]

    actor = ActorContext(
        owner_user_id=owner_user_id,
        platform=platform,
        platform_user_id=platform_user_id,
        platform_user_name=payload.get("platform_user_name") or platform_message.sender.name,
        role=role,
        chat_type=chat_type,
        chat_id=platform_message.chat.id if chat_type == "group" else None,
        allowed_tool_names=allowed_tool_names,
    )
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
    )
    return PreparedImRequest(request, actor, role, allowed_tool_names, route, session_id)


async def dispatch_im_message(payload: dict):
    """处理一条已入队 IM 消息的完整业务编排。

    Redis worker 只负责消费、去重、防抖和生命周期；身份、权限、被动记录、
    shortcut、模型执行、session 写回和出站回复均在这里完成，三平台共用同一条
    可测试的 IM Loop。
    """
    from agent import logsafe, trace
    from agent.im.replies import send_agent_response, send_stream_with_fallback, send_text

    platform_message = PlatformMessage.from_payload(payload)
    payload = platform_message.to_payload(payload)
    prepared = await prepare_message(payload, platform_message)
    if prepared is None:
        await send_text(payload, "你好，我是咕咕 🐦\n这个机器人还没和咕咕账号关联好，去咕咕「个人设置 → 接入咕咕」重新扫码连接一下吧。")
        return None

    req = prepared.request
    user_id = req.user_id
    platform = prepared.actor.platform
    puid = prepared.actor.platform_user_id
    route = prepared.session_route
    session_scope = route.scope_id
    req.session_id = prepared.session_id
    trace_id = trace.set_trace(payload.get("trace_id"))

    if should_record_passive_group(req, payload):
        passive_sid = await record_passive_im_message(req, prepared.session_id)
        await persist_im_session(platform, route.bot_id, session_scope, passive_sid, group=True)
        print(f"[im-loop] {platform} 群聊普通消息已记录(session={passive_sid} trace={trace_id})", flush=True)
        return None

    shortcut = await decide_im_shortcut(
        platform,
        puid or "",
        req.message,
        has_attachments=bool(req.attachments),
    )
    if shortcut["action"] == "drop":
        return None
    if shortcut["action"] in ("reply", "cancel"):
        await apply_im_shortcut_cancel(platform, puid or "", shortcut)
        await send_text(payload, shortcut["reply"])
        await finalize_im_response(platform, puid or "", shortcut["action"] == "cancel", shortcut["reply"])
        return None

    cmd_reply = await handle_im_command(user_id, req.message)
    if cmd_reply is not None:
        await send_text(payload, cmd_reply)
        return None

    bind_im_context(req, payload)
    await remember_im_reach(user_id, platform, payload, puid)
    activity = await start_im_activity(payload, platform, puid)
    agent_loop = select_loop(req)
    try:
        if platform == "feishu":
            token_iter = agent_loop.run_stream(req)
            _stream_sent, resp, reply_text = await send_stream_with_fallback(payload, token_iter)
        else:
            resp = await agent_loop.run_collect(req)
            reply_text = ""
    finally:
        await finish_im_activity(activity)

    await persist_im_session(
        platform,
        route.bot_id,
        session_scope,
        resp.session_id,
        group=bool(payload.get("chat_type") == "group"),
    )
    if resp.cancelled:
        await finalize_im_response(platform, puid, True, "")
        return resp

    if platform != "feishu" or resp.files:
        reply_text = await send_agent_response(payload, resp)

    await finalize_im_response(platform, puid, False, reply_text)
    print(
        f"[im-loop] {platform} 回复(session={resp.session_id} trace={trace_id}) "
        f"len={len(reply_text)} fp={logsafe.fingerprint(reply_text)}",
        flush=True,
    )
    return resp
