"""IM 活跃状态、typing 与平台触达信息。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class ImActivity:
    """一次 IM 模型执行期间的忙碌态和平台 typing 句柄。"""

    platform: str
    platform_user_id: str
    typing_indicator: Any
    bot_id: str = ""
    scope_id: str = ""
    typing_stopped: bool = False


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
    await runtime_state.clear_state(
        activity.platform, activity.bot_id, activity.scope_id, activity.platform_user_id
    )
    await runtime_state.clear_cancel(
        activity.platform, activity.bot_id, activity.scope_id, activity.platform_user_id
    )
    await runtime_state.unmark_active(
        activity.platform, activity.bot_id, activity.scope_id, activity.platform_user_id
    )
    await stop_im_typing(activity)


async def stop_im_typing(activity: ImActivity) -> None:
    """在交互等待前结束 typing，但保留会话活跃状态。"""
    if activity.typing_stopped:
        return
    activity.typing_stopped = True
    from agent.gateway import wechat

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


def bind_im_context(
    request: AgentRequest,
    payload: dict,
    *,
    tool_display_mode: str = "all",
) -> None:
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
        [str(item) for item in (request.attachments or [])],
        tool_display_mode=tool_display_mode,
        group_auto_reply=bool(getattr(request, "group_auto_reply", False)),
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
