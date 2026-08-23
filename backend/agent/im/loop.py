"""IM Loop 的请求准备门面。

这里先收口“平台消息 → ActorContext → AgentRequest”这一段，不复制模型循环。
worker 仍负责 Redis 消费、被动群消息、命令/intent shortcut 的执行和平台发送；
后续阶段再把 owner/member 的完整调用流程迁入这里。
"""
from __future__ import annotations

import json
import random
from dataclasses import dataclass
from typing import Any, List, Optional

from agent.im.actor import ActorContext, ActorResolver
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
    trim_session_messages,
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
    bot_id: str = ""
    scope_id: str = ""


class OwnerAgentLoop:
    """Web/owner IM 共用的完整 Agent Loop 门面。"""

    async def run_collect(self, request: AgentRequest, *, on_interaction=None, on_tool_event=None):
        from agent.runner import run_collect
        kwargs = {"on_interaction": on_interaction}
        if on_tool_event is not None:
            kwargs["on_tool_event"] = on_tool_event
        return await run_collect(request, **kwargs)

    def run_stream(self, request: AgentRequest, *, on_interaction=None, on_tool_event=None):
        from agent.runner import run_stream
        if on_interaction is None and on_tool_event is None:
            # 保持旧的测试/扩展实现兼容：未使用交互回调时不强行传新关键字。
            return run_stream(request)
        kwargs = {}
        if on_interaction is not None:
            kwargs["on_interaction"] = on_interaction
        if on_tool_event is not None:
            kwargs["on_tool_event"] = on_tool_event
        try:
            return run_stream(request, **kwargs)
        except TypeError as exc:
            # 旧的外部 Loop 替身/扩展可能还没有工具事件回调；只对明确的
            # 关键字不兼容回退，不能吞掉生成器内部的 TypeError。
            if "on_tool_event" not in str(exc):
                raise
            kwargs.pop("on_tool_event", None)
            try:
                return run_stream(request, **kwargs)
            except TypeError as legacy_exc:
                if "on_interaction" not in str(legacy_exc):
                    raise
                return run_stream(request)


class MemberAgentLoop(OwnerAgentLoop):
    """member/unknown 的轻量入口，权限和上下文由 request policy 收紧。"""


async def decide_im_shortcut(
    platform: str,
    platform_user_id: str,
    text: str,
    *,
    has_attachments: bool = False,
    bot_id: str = "",
    scope_id: str = "",
    allow_leading_mention: bool = False,
) -> dict:
    """根据当前 IM 状态判断是否需要在入队前短路。"""
    if has_attachments:
        return {"action": "run"}
    from agent import router
    from agent.runtime import runtime_state

    try:
        state = await runtime_state.get_state(
            platform, bot_id or "", scope_id or platform_user_id, platform_user_id
        )
        awaiting = await runtime_state.is_awaiting(platform, platform_user_id)
        # 查询当前会话活跃 loop 的发起者 puid 集合，供 router 判断「其他用户取消」的权限。
        active_puid = await runtime_state.get_active(
            platform, bot_id or "", scope_id or platform_user_id
        )
    except Exception as exc:
        # shortcut 只是优化，Redis 故障不能阻断消息进入 Stream；worker 会继续按
        # 完整上下文处理本条消息。
        from app.core.redaction import diag_log, redact
        diag_log("agent.im.shortcut.read", exc)
        print(f"[im] shortcut 状态读取失败，继续入队: {redact(type(exc).__name__)}", flush=True)
        return {"action": "run"}
    dec = router.decide(
        text, state, awaiting,
        current_puid=platform_user_id,
        active_puid=active_puid,
        allow_leading_mention=allow_leading_mention,
    )
    if dec.get("action") == "cancel":
        # 取消是实时控制信号，这里记录「谁在什么状态下发起了取消」，便于排查取消未生效
        # （busy=False 时 router 不会返回 cancel，会当普通消息入队）。puid 用指纹脱敏。
        from agent.security.logsafe import fingerprint
        from app.core.redaction import diag_log_raw
        diag_log_raw(
            "agent.im.shortcut.cancel_decided",
            f"platform={platform} puid={fingerprint(platform_user_id)} "
            f"state={state} awaiting={awaiting}",
        )
    return dec


def decide_im_shortcut_sync(
    platform: str,
    platform_user_id: str,
    text: str,
    *,
    has_attachments: bool = False,
    bot_id: str = "",
    scope_id: str = "",
    allow_leading_mention: bool = False,
) -> dict:
    """同步 Gateway 回调使用的 intent shortcut 决策。"""
    if has_attachments:
        return {"action": "run"}
    from agent import router
    from agent.runtime import runtime_state

    try:
        state = runtime_state.get_state_sync(
            platform, bot_id or "", scope_id or platform_user_id, platform_user_id
        )
        awaiting = runtime_state.is_awaiting_sync(platform, platform_user_id)
        # 查询当前会话活跃 loop 的发起者 puid 集合，供 router 判断「其他用户取消」的权限。
        active_puid = runtime_state.get_active_sync(
            platform, bot_id or "", scope_id or platform_user_id
        )
    except Exception as exc:
        from app.core.redaction import diag_log, redact
        diag_log("agent.im.shortcut.read_sync", exc)
        print(f"[im] shortcut 状态读取失败，继续入队: {redact(type(exc).__name__)}", flush=True)
        return {"action": "run"}
    dec = router.decide(
        text, state, awaiting,
        current_puid=platform_user_id,
        active_puid=active_puid,
        allow_leading_mention=allow_leading_mention,
    )
    if dec.get("action") == "cancel":
        from agent.security.logsafe import fingerprint
        from app.core.redaction import diag_log_raw
        diag_log_raw(
            "agent.im.shortcut.cancel_decided_sync",
            f"platform={platform} puid={fingerprint(platform_user_id)} "
            f"state={state} awaiting={awaiting}",
        )
    return dec


async def apply_im_shortcut_cancel(platform: str, platform_user_id: str, decision: dict,
                                   *, bot_id: str = "", scope_id: str = "") -> None:
    """执行短路决策中的取消动作，状态修改仍归 IM Loop。

    bot_id/scope_id 与活跃集合同作用域：取消标志按会话隔离，避免跨群误取消。
    """
    if decision.get("action") == "cancel":
        from agent.runtime import runtime_state
        try:
            written = await runtime_state.request_cancel(
                platform, bot_id or "", scope_id or platform_user_id, platform_user_id
            )
        except Exception as exc:
            from app.core.redaction import diag_log, redact
            diag_log("agent.im.shortcut.cancel", exc)
            print(f"[im] 取消状态写入失败: {redact(type(exc).__name__)}", flush=True)
            return
        # 只有真的 SET 成功才记"取消已生效"——request_cancel 在 bot_id/scope_id 缺失时
        # 会静默 no-op 返回 False，之前这里不检查返回值，会打出「写成功」的假日志
        # （code review 发现：调用方漏传 scope 时，日志会撒谎）。
        from agent.security.logsafe import fingerprint
        from app.core.redaction import diag_log_raw
        if written:
            diag_log_raw(
                "agent.im.shortcut.cancel_written",
                f"platform={platform} puid={fingerprint(platform_user_id)}",
            )
        else:
            diag_log_raw(
                "agent.im.shortcut.cancel_noop_missing_scope",
                f"platform={platform} puid={fingerprint(platform_user_id)} "
                f"has_bot_id={bool(bot_id)} has_scope_id={bool(scope_id)}",
            )


def apply_im_shortcut_cancel_sync(platform: str, platform_user_id: str, decision: dict,
                                  *, bot_id: str = "", scope_id: str = "") -> None:
    """同步 Gateway 回调使用的取消动作。"""
    if decision.get("action") == "cancel":
        from agent.runtime import runtime_state
        try:
            written = runtime_state.request_cancel_sync(
                platform, bot_id or "", scope_id or platform_user_id, platform_user_id
            )
        except Exception as exc:
            from app.core.redaction import diag_log, redact
            diag_log("agent.im.shortcut.cancel_sync", exc)
            print(f"[im] 取消状态写入失败: {redact(type(exc).__name__)}", flush=True)
            return
        from agent.security.logsafe import fingerprint
        from app.core.redaction import diag_log_raw
        if written:
            diag_log_raw(
                "agent.im.shortcut.cancel_written_sync",
                f"platform={platform} puid={fingerprint(platform_user_id)}",
            )
        else:
            diag_log_raw(
                "agent.im.shortcut.cancel_noop_missing_scope_sync",
                f"platform={platform} puid={fingerprint(platform_user_id)} "
                f"has_bot_id={bool(bot_id)} has_scope_id={bool(scope_id)}",
            )


async def start_im_activity(payload: dict, platform: str, platform_user_id: str) -> ImActivity:
    """设置 IM 忙碌态，并启动平台支持的 typing 指示器。"""
    from agent.runtime import runtime_state
    from agent.gateway import wechat

    # 会话作用域：bot_id=channel_id、scope_id=chat_id（私聊回退到 puid），与活跃集合同 key。
    bot_id = payload.get("channel_id") or ""
    scope_id = payload.get("chat_id") or platform_user_id
    # clear_cancel + mark_active + set_state 三步用一次 Redis 端原子操作完成
    # （runtime_state.init_activity），外部不会观察到"取消已清、但状态还没变成
    # THINKING"的中间态——见该函数文档，这是 code review 复审指出的残留竞态窗口：
    # 顺序调用三条独立命令即使顺序正确，命令之间仍有极小间隙，用户此时发"取消"会
    # 因为网关读到的 state 还是 IDLE（判断依据是 state != IDLE）而被当成普通消息。
    await runtime_state.init_activity(
        platform, bot_id, scope_id, platform_user_id, runtime_state.THINKING
    )
    typing_indicator = await wechat.start_typing(payload)
    return ImActivity(platform, platform_user_id, typing_indicator, bot_id, scope_id)


async def finish_im_activity(activity: ImActivity) -> None:
    """无论模型成功、失败或取消，都清理忙碌态和 typing 指示器。"""
    from agent.runtime import runtime_state
    from agent.gateway import wechat

    await runtime_state.clear_state(
        activity.platform, activity.bot_id, activity.scope_id, activity.platform_user_id
    )
    await runtime_state.clear_cancel(
        activity.platform, activity.bot_id, activity.scope_id, activity.platform_user_id
    )
    await runtime_state.unmark_active(
        activity.platform, activity.bot_id, activity.scope_id, activity.platform_user_id
    )
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
    from agent.im import imctx

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
    from agent import router
    from agent.runtime import runtime_state

    if cancelled:
        await runtime_state.set_awaiting(platform, platform_user_id, False)
        return
    await runtime_state.set_awaiting(
        platform,
        platform_user_id,
        router.reply_awaits_answer(reply_text),
    )


async def handle_im_command(user_id, message: str, session_id: Optional[int] = None,
                            *, allow_leading_mention: bool = False) -> Optional[str]:
    """处理不需要模型的 IM 命令，返回回复文本或 ``None``。"""
    from agent import commands

    return await commands.handle(
        user_id,
        message,
        session_id=session_id,
        allow_leading_mention=allow_leading_mention,
    )


async def record_passive_im_message(request: AgentRequest, session_id: Optional[int] = None) -> int:
    """保存未触发回复的群消息，供后续 @ 咕咕时读取同一会话上下文。"""
    import app.db.session as db_session
    from sqlalchemy import desc, select
    from app.models import ConversationMessage, ConversationSession

    attachment_cards = []
    if request.attachments:
        from app.core import chat_attach

        metas = await chat_attach.get_meta_many(request.user_id, request.attachments)
        for attach_id in request.attachments:
            meta = metas.get(str(attach_id))
            if not meta:
                continue
            attachment_cards.append({
                "attach_id": meta["attach_id"],
                "name": meta["name"],
                "ext": meta["ext"],
                "size_bytes": meta["size"],
                "kind": meta["kind"],
                "mime": meta.get("mime"),
                "qq_face": bool(meta.get("qq_face")),
                "quoted": bool(meta.get("quoted")),
                "upload": True,
                "duration": meta.get("duration"),
                "img_width": meta.get("img_width"),
                "img_height": meta.get("img_height"),
            })

    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        session = await db.get(ConversationSession, session_id) if session_id else None
        if session is not None and (
            session.user_id != request.user_id
            or session.source != (request.source or "qq")
            or session.bot_id != request.platform_bot_id
            or session.chat_id != request.chat_id
        ):
            # Redis 路由异常或旧 key 不得把消息写进另一个 Bot/群的会话。
            session = None
        if session is None and request.chat_id:
            # Redis 只是路由缓存：过期、重启或并发 miss 时，必须按稳定的群作用域
            # 回查数据库，不能因为缓存缺失给同一个群重复创建会话。
            session = (await db.execute(
                select(ConversationSession)
                .where(
                    ConversationSession.user_id == request.user_id,
                    ConversationSession.source == (request.source or "qq"),
                    ConversationSession.bot_id == request.platform_bot_id,
                    ConversationSession.chat_id == request.chat_id,
                    ConversationSession.chat_type == "group",
                )
                .order_by(desc(ConversationSession.updated_at), desc(ConversationSession.id))
                .limit(1)
            )).scalars().first()
        if session is None:
            session = ConversationSession(
                user_id=request.user_id,
                title=(request.message[:50] or "群聊记录"),
                source=request.source or "qq",
                bot_id=request.platform_bot_id,
                chat_id=request.chat_id,
                chat_type=("group" if request.chat_id else
                           "c2c" if request.source in IM_SOURCES else None),
            )
            db.add(session)
            await db.flush()
        message_row = ConversationMessage(
            session_id=session.id,
            role="user",
            content=request.message,
            quoted_text=request.quoted_text,
            platform_user_id=request.platform_user_id,
            platform_user_name=request.platform_user_name,
            platform_bot_user_id=request.platform_bot_user_id,
            chat_type=("group" if request.chat_id else
                       "c2c" if request.source in IM_SOURCES else None),
            files=attachment_cards or None,
        )
        db.add(message_row)
        await db.flush()
        # 被动记录路径，同样遵守"消息+附件 claim 同事务"（不变量 3）；这里失败极罕见
        # （只可能是并发 claim/GC 抢跑），rollback 后跳过这条消息记录，不影响群聊主链路。
        from app.core import chat_attach
        try:
            await chat_attach.claim_attachments(
                db, request.user_id, message_row.id,
                [c["attach_id"] for c in attachment_cards])
        except chat_attach.AttachmentClaimError as exc:
            await db.rollback()
            from app.core.redaction import diag_log
            diag_log("agent.im.loop.record_passive_im_message.claim", exc)
            return session_id or session.id
        await db.commit()
        await trim_session_messages(session.id)
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
                    "files": attachment_cards,
                }],
            )
        except Exception:
            pass
        recorded_session_id = session.id
        recorded_message_id = message_row.id
    if request.chat_id and recorded_message_id:
        try:
            from agent.memory.reflection_jobs import observe_group_message, observe_member_message
            from agent.memory.scopes import MemoryScope

            group_scope = MemoryScope(
                    request.user_id,
                    request.source or "qq",
                    str(request.platform_bot_id or ""),
                    "group",
                    str(request.chat_id),
                )
            await observe_group_message(
                group_scope,
                recorded_message_id,
                message_row.created_at,
            )
            if request.im_role == "member" and request.platform_user_id:
                await observe_member_message(
                    MemoryScope(
                        request.user_id,
                        request.source or "qq",
                        str(request.platform_bot_id or ""),
                        "platform-user",
                        str(request.platform_user_id),
                    ),
                    recorded_message_id,
                    message_row.created_at,
                )
            elif request.im_role == "owner":
                from app.core.config import get_settings
                from agent.memory import reflection

                reflection.schedule(
                    request.user_id,
                    request.user_name,
                    request.message,
                    "",
                    get_settings(),
                    group_mode=True,
                )
        except Exception:
            # 记忆调度不能阻断消息落库和网页会话同步。
            pass
    return recorded_session_id


def should_record_passive_group(request: AgentRequest, payload: dict) -> bool:
    """判断是否只记录当前群消息而不触发回复。

    网关始终接收 QQ 平台实际投递的群消息；这里仅负责回应方式的业务语义：
    ``record_only`` 记录全部消息，``reply_mentions`` 记录非 @ 消息，@ 消息
    继续进入模型回复流程。
    """
    return bool(
        request.source == "qq"
        and request.chat_id
        and payload.get("chat_type") == "group"
        and (
            payload.get("group_read_enabled")
            or (
                payload.get("group_requires_at")
                and not payload.get("group_mentioned")
            )
        )
    )


async def persist_im_session(
    platform: str,
    bot_id: str,
    scope_id: str,
    session_id: Optional[int],
    *,
    group: bool = False,
) -> None:
    """写回 IM 路由 session，并在私聊/群聊路径统一执行消息窗口裁剪。"""
    if group:
        await set_session(platform, bot_id, scope_id, session_id)
        if session_id:
            await trim_session_messages(session_id)
        return
    # 私聊读取的是 owner-session 绑定，不能再写入旧的通用 imsession key。
    # 这里由 session 记录反查其用户归属，避免从平台字段重新推断 owner。
    await bind_session_by_id(platform, scope_id, session_id, bot_id)
    if session_id:
        await trim_session_messages(session_id)





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
    route = session_route or resolve_route(platform_message, payload)
    actor = await ActorResolver(access_resolver=resolve_access).resolve(
        platform_message, payload, owner_user_id
    )
    platform = actor.platform
    platform_user_id = actor.platform_user_id
    chat_type = actor.chat_type
    role = actor.role
    allowed_tool_names = actor.allowed_tool_names
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
    )
    # 临时定位 ask_user 未出现在 QQ 私聊模型工具列表的问题；不记录用户 ID 或正文。
    print(json.dumps({
        "probe": "runtime-ask-user-tools",
        "phase": "request-permission",
        "platform": platform,
        "chatType": chat_type,
        "role": role,
        "allowedToolCount": len(allowed_tool_names) if allowed_tool_names is not None else None,
        "allowedIsFull": allowed_tool_names is None,
        "askUserAllowed": allowed_tool_names is None or "ask_user" in allowed_tool_names,
    }, ensure_ascii=False, separators=(",", ":")), flush=True)
    return PreparedImRequest(request, actor, role, allowed_tool_names, route, session_id)


async def dispatch_im_message(payload: dict):
    """处理一条已入队 IM 消息的完整业务编排。

    Redis worker 只负责消费、去重、防抖和生命周期；身份、权限、被动记录、
    shortcut、模型执行、session 写回和出站回复均在这里完成，三平台共用同一条
    可测试的 IM Loop。
    """
    from agent.security import logsafe
    from agent.runtime import trace
    from agent.im.replies import send_agent_response, send_stream_with_fallback, send_text

    if payload.get("platform") == "qq":
        raw_attachments = payload.get("attachments") or []
        # 系统表情可能只有 emoji_refs，没有 QQ 原始附件；两者都要经过媒体入口，
        # 否则 QFace 无法补图，最终只会保留网关的占位文本。
        if any(isinstance(item, dict) for item in raw_attachments) or payload.get("emoji_refs"):
            from agent.im.media_ingress import ingest_qq_media

            payload = dict(payload)
            payload["attachments"] = await ingest_qq_media(
                raw_attachments,
                str(payload.get("owner_user_id") or ""),
                str(payload.get("message_id") or ""),
                payload.get("emoji_refs") or [],
                str(payload.get("platform_message_id") or ""),
            )
            # faceType=3 的 ext 可能带一个文字标签；QFace 成功补图后，纯表情消息
            # 不应同时展示标签和图片。未匹配到资源时保留网关的兜底文字。
            if payload.get("emoji_refs") and not any(
                isinstance(item, dict) for item in raw_attachments
            ) and payload["attachments"]:
                payload["text"] = ""
        if payload.get("platform_bot_user_id"):
            from agent.im.identity import remember_bot_platform_user_id

            await remember_bot_platform_user_id(
                str(payload.get("channel_id") or ""),
                str(payload["platform_bot_user_id"]),
            )

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
    trace.bind_im_run(prepared.session_id, platform)

    if should_record_passive_group(req, payload):
        passive_sid = await record_passive_im_message(req, prepared.session_id)
        await persist_im_session(platform, route.bot_id, session_scope, passive_sid, group=True)
        trace.bind_im_run(passive_sid, platform)
        trace.finish_run("success")
        print(f"[im-loop] {platform} 群聊普通消息已记录(session={passive_sid} trace={trace_id})", flush=True)
        return None

    shortcut = await decide_im_shortcut(
        platform,
        puid or "",
        req.message,
        has_attachments=bool(req.attachments),
        bot_id=route.bot_id,
        scope_id=session_scope,
        allow_leading_mention=bool(payload.get("group_mentioned")),
    )
    if shortcut["action"] == "drop":
        trace.finish_run("success")
        return None
    if shortcut["action"] in ("reply", "cancel"):
        # bot_id/scope_id 必须一起传——request_cancel() 要求 platform+bot_id+scope_id+puid
        # 全部非空才会真正写标志，否则静默 no-op（code review 发现：这里漏传导致 fallback
        # 路径的取消从来没真正生效过，QQ 主路径因为走了另一条已正确传 scope 的路径掩盖了这个问题）。
        await apply_im_shortcut_cancel(platform, puid or "", shortcut, bot_id=route.bot_id, scope_id=session_scope)
        await send_text(payload, shortcut["reply"])
        trace.finish_run("cancelled" if shortcut["action"] == "cancel" else "success", shortcut["reply"])
        await finalize_im_response(platform, puid or "", shortcut["action"] == "cancel", shortcut["reply"])
        return None
    if shortcut["action"] == "no_permission":
        # 咕咕在跑别人的 loop，当前用户无权取消：回一句提示，不入队。
        await send_text(payload, shortcut["reply"])
        trace.finish_run("success", shortcut["reply"])
        return None

    cmd_reply = await handle_im_command(
        user_id,
        req.message,
        prepared.session_id,
        allow_leading_mention=bool(payload.get("group_mentioned")),
    )
    if cmd_reply is not None:
        await send_text(payload, cmd_reply)
        trace.finish_run("success", cmd_reply)
        return None

    bind_im_context(req, payload)
    await remember_im_reach(user_id, platform, payload, puid)
    activity = await start_im_activity(payload, platform, puid)
    agent_loop = select_loop(req)
    shown_interaction_ids: set[int] = set()
    show_tool_interactions = await _should_show_tool_interactions(req.user_id)

    async def _show_tool_event(event: dict) -> None:
        """按用户偏好独立发送工具状态，不影响 Agent 主循环。"""
        if not show_tool_interactions:
            return
        from agent.im.replies import send_tool_event
        await send_tool_event(payload, event)

    async def _show_qq_interaction(interaction: dict) -> None:
        """在共享 Runner 进入等待前，把 QQ 文本提示即时发出去。"""
        if platform != "qq":
            return
        # 流式消息必须先发送 DONE 帧；QQ 在 stream_messages 尚未结束时
        # 不会可靠展示 Inline Keyboard。流式路径由回合结束后的统一分支发送。
        if qq_private_streaming:
            return
        try:
            await _send_interaction_prompts(payload, [interaction])
        except Exception as exc:
            # 平台展示失败不能取消当前 Run；网页仍可从 active prompt 恢复交互。
            from app.core.redaction import diag_log
            diag_log("agent.im.qq.interaction_display", exc)
            return
        prompt_id = interaction.get("prompt_id")
        if prompt_id is not None:
            shown_interaction_ids.add(int(prompt_id))

    qq_private_streaming = False
    if platform == "qq" and payload.get("chat_type") == "c2c":
        from agent.im.message_format import resolve_private_streaming_enabled
        qq_private_streaming = await resolve_private_streaming_enabled(route.bot_id)
        # QQ 的私聊流消息在 ask_user/确认交互时会一直保持「发送中」，而
        # Inline Keyboard 是另一条消息接口；部分 QQ 客户端在前一个 stream
        # 未结束时不会展示键盘。启用交互提示时改走 collect，确保键盘可靠送达。
        if qq_private_streaming and show_tool_interactions:
            qq_private_streaming = False
    try:
        if platform == "feishu":
            token_iter = agent_loop.run_stream(req, on_tool_event=_show_tool_event)
            _stream_sent, resp, reply_text = await send_stream_with_fallback(payload, token_iter)
        elif qq_private_streaming:
            token_iter = agent_loop.run_stream(
                req,
                on_interaction=_show_qq_interaction,
                on_tool_event=_show_tool_event,
            )
            _stream_sent, resp, reply_text = await send_stream_with_fallback(payload, token_iter)
        else:
            resp = await agent_loop.run_collect(
                req,
                on_interaction=_show_qq_interaction if platform == "qq" else None,
                on_tool_event=_show_tool_event,
            )
            reply_text = ""
    except BaseException:
        trace.finish_run("error")
        raise
    finally:
        await finish_im_activity(activity)

    await persist_im_session(
        platform,
        route.bot_id,
        session_scope,
        resp.session_id,
        group=bool(payload.get("chat_type") == "group"),
    )
    if req.chat_id and resp.session_id:
        try:
            from agent.memory.reflection_jobs import observe_session_activity
            from agent.memory.scopes import MemoryScope

            await observe_session_activity(
                MemoryScope(
                    req.user_id,
                    req.source or "qq",
                    str(req.platform_bot_id or ""),
                    "group",
                    str(req.chat_id),
                ),
                resp.session_id,
            )
        except Exception:
            # 记忆调度失败不影响当前回复已经完成。
            pass
        if prepared.actor.role == "member" and req.platform_user_id:
            try:
                from agent.memory.reflection_jobs import observe_member_activity
                from agent.memory.scopes import MemoryScope

                await observe_member_activity(
                    MemoryScope(
                        req.user_id,
                        req.source or "qq",
                        str(req.platform_bot_id or ""),
                        "platform-user",
                        str(req.platform_user_id),
                    ),
                    resp.session_id,
                    str(req.platform_user_id),
                    used_tools=bool(getattr(resp, "used_tools", False)),
                )
            except Exception:
                # 成员记忆是后台增强能力，不影响群聊回复。
                pass
    if resp.cancelled:
        trace.finish_run("cancelled")
        await finalize_im_response(platform, puid, True, "")
        return resp

    # 工具交互是独立展示层：关闭时仍执行工具、保存历史和完成确认，只跳过 IM 展示。
    show_interactions = show_tool_interactions
    if resp.interactions and show_interactions:
        pending_interactions = [
            item for item in resp.interactions
            if item.get("prompt_id") not in shown_interaction_ids
        ]
        if pending_interactions:
            await _send_interaction_prompts(payload, pending_interactions)

    if platform == "qq" and qq_private_streaming and _stream_sent:
        if resp.files:
            from agent.im.files import send_files
            file_result = await send_files(payload, resp.files)
            if file_result.failed:
                await send_text(payload, file_result.reason or "附件没有成功发出，你可以去网页或文件库查看。")
    elif platform != "feishu" or resp.files:
        reply_text = await send_agent_response(payload, resp)

    trace.finish_run("success", reply_text)
    await finalize_im_response(platform, puid, False, reply_text)
    print(
        f"[im-loop] {platform} 回复(session={resp.session_id} trace={trace_id}) "
        f"len={len(reply_text)} fp={logsafe.fingerprint(reply_text)}",
        flush=True,
    )
    return resp


async def _should_show_tool_interactions(user_id) -> bool:
    from agent.interactions.preferences import show_tool_interactions
    return await show_tool_interactions(user_id)


async def _send_interaction_prompts(payload: dict, interactions: list[dict]) -> None:
    """发送平台可理解的交互摘要；未接入原生按钮的平台使用文本摘要。"""
    from agent.im.replies import send_interaction

    for item in interactions:
        await send_interaction(payload, item)
