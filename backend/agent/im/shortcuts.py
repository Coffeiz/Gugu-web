"""IM shortcut 判断与取消控制。"""
from __future__ import annotations


def _qq_private_streaming_requested(
    platform: str, chat_type: str | None, message_format: str | None,
) -> bool:
    """QQ 私聊选择 Markdown 时流式发送；兼容格式和群聊维持非流式。"""
    return platform == "qq" and chat_type == "c2c" and message_format == "markdown"


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
