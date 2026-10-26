"""Web Gateway run_lifecycle 实现。"""
from __future__ import annotations
import asyncio
import contextlib
import logging
from agent.errors import describe_llm_error
from agent.llm import genstream
from .generation import _generate_unlocked, _refresh_generation_history
logger = logging.getLogger(__name__)

_gen_tasks: set = set()   # 持后台生成任务引用，防 GC（任务需脱离请求存活）
_session_gen_tasks: dict[int, dict[str, asyncio.Task]] = {}


def cancel_local_generation(session_id: int, owner_run_id: str | None = None) -> bool:
    """同进程内直接取消该会话的后台生成任务；任务不在本进程时返回 False。

    ``owner_run_id`` 指定要取消的 run（终止端点从快照读当前归属传入）——排队
    场景下不能按「最新登记」取消，否则杀掉的是排队任务而真正在跑的 run 继续。
    未指定时回退为取消该会话全部存活任务（兼容旧行为语义）。
    uvicorn 多 worker 下生成任务可能活在另一个进程，此时由调用方回退到
    genstream 取消标记（run 心跳会自行发现并退出）。
    """
    registry = _session_gen_tasks.get(session_id)
    if not registry:
        return False
    if owner_run_id:
        task = registry.get(owner_run_id)
        if task is not None and not task.done():
            task.cancel()
            return True
        return False
    cancelled = False
    for task in registry.values():
        if not task.done():
            task.cancel()
            cancelled = True
    return cancelled


async def _generate(req, session_id, snapshot, history, is_new_session,
                    user_content=None, user_images=None, attach_cards=None,
                    user_media=None, user_tz=None, sent_at=None,
                    user_message=None, resume_interaction: bool = False,
                    strip_thinking: bool = False, session=None,
                    history_stats=None, model_cfg=None, run_config=None, locale=None,
                    owner_run_id=None,
                    begin_after_gate: bool = False) -> None:
    """持有 session gate 运行 Web 后台生成，并等待 baseline 提交完成。

    预处理（刷新历史、能力目录校验等）也在这里执行；这些步骤若异常，不能
    绕过 ``_generate_unlocked`` 的收口，否则 genstream 会一直停在生成中。

    ``begin_after_gate=True`` 给排队任务用：run 进行中到达的消息，任务要先在
    session gate 上等前一个 run 结束才能开始；``genstream.begin`` 若在排队时
    执行会清掉当前 run 的快照和归属，必须等拿到门后再初始化自己的快照。
    """
    from agent.context import compress_conv

    owner_run_id = owner_run_id or genstream.new_run_id()
    from app.services.conversation_run_outcomes import RunOutcomeTarget
    outcome_target = RunOutcomeTarget(
        user_id=req.user_id,
        session_id=session_id,
        user_message_id=getattr(user_message, "id", None),
        run_id=owner_run_id,
    )
    # run 级进程心跳：长工具调用/交互等待期间没有 token 事件，快照 TTL 得不到
    # 刷新；这个心跳让「快照非 done 但心跳已断」可以安全判定为 crash 僵尸
    # （见 genstream.beat_alive / reap 与 recover_orphaned_session）。
    # 跨 worker 取消通过 Redis Pub/Sub 主动唤醒；持久标记仍保留，每 5s 读回一次
    # 作为断线/漏通知兜底。收到通知后仍校验 owner，防止旧 run 的取消误伤排队 run。
    # 排队任务（begin_after_gate）在拿到门、begin 清掉旧标记之前必须忽略取消
    # 标记——那可能是给上一个 run 的「停止」，不该连带杀掉排队的这条消息。
    generate_task = asyncio.current_task()
    run_begun = not begin_after_gate

    async def _run_heartbeat() -> None:
        nonlocal run_begun
        loop = asyncio.get_running_loop()
        last_touch = 0.0
        pubsub = None
        try:
            while True:
                if not run_begun:
                    now = loop.time()
                    if now - last_touch >= 30:
                        await genstream.touch(session_id)
                        last_touch = now
                    await asyncio.sleep(5)
                    continue

                if pubsub is None:
                    try:
                        pubsub = await genstream.open_cancel_subscription(session_id)
                    except Exception as exc:
                        from app.core.redaction import diag_log

                        diag_log("agent.genstream.cancel_subscribe", exc)
                        if run_begun and await genstream.is_cancelled(session_id):
                            if generate_task is not None:
                                generate_task.cancel()
                            return
                        await asyncio.sleep(1)
                        continue

                # 订阅先于读标记，覆盖“取消恰好发生在订阅建立前”的竞态。
                if await genstream.is_cancelled(session_id):
                    if generate_task is not None:
                        generate_task.cancel()
                    return
                try:
                    if await genstream.wait_for_cancel_signal(session_id, pubsub, timeout=5.0):
                        if generate_task is not None:
                            generate_task.cancel()
                        return
                except Exception as exc:
                    from app.core.redaction import diag_log

                    diag_log("agent.genstream.cancel_listener", exc)
                    try:
                        await pubsub.aclose()
                    except Exception:
                        pass
                    pubsub = None
                    continue

                now = loop.time()
                if now - last_touch >= 30:
                    await genstream.touch(session_id)
                    last_touch = now
        finally:
            if pubsub is not None:
                try:
                    await pubsub.aclose()
                except Exception:
                    pass

    heartbeat_task = asyncio.create_task(_run_heartbeat())
    try:
        # 进入会话门前如果基线整理还在进行，先给订阅端发一条排队提示，
        # 否则用户发的消息会静默等待几十秒，看起来像「发了没反应」。
        if await compress_conv._read_execution_state(session_id) == "baseline_updating":
            await genstream.publish(session_id, {
                "type": "_context_compaction", "phase": "started", "reason": "queued_baseline",
            })
        async with compress_conv.session_run_gate(req, run_id=owner_run_id) as claimed_owner_run_id:
            if begin_after_gate:
                claimed = claimed_owner_run_id or owner_run_id
                # begin 会重置快照并清掉 cancel 标记和租约；租约刚由门内 claim，
                # begin 之后立即补回来，避免出现「无租约的活跃快照」被孤儿回收。
                await genstream.begin(session_id, owner_run_id=claimed)
                await genstream.claim_lease(session_id, claimed)
                from app.core import events
                await events.publish_agent_run_changed(
                    req.user_id, session_id=session_id, status="running",
                )
            # 从这一刻起本 run 已接管快照（旧的取消标记已被 begin 清掉），
            # 心跳开始按本 run 的取消标记工作。
            run_begun = True
            refreshed = await _refresh_generation_history(
                session_id, snapshot, model_cfg,
            )
            if refreshed is not None:
                session, snapshot, history, history_stats, strip_thinking = refreshed
            await _generate_unlocked(
                req, session_id, snapshot, history, is_new_session,
                user_content=user_content, user_images=user_images,
                attach_cards=attach_cards, user_media=user_media,
                user_tz=user_tz, sent_at=sent_at, user_message=user_message,
                resume_interaction=resume_interaction, strip_thinking=strip_thinking,
                session=session, history_stats=history_stats, model_cfg=model_cfg,
                run_config=run_config,
                locale=locale,
                owner_run_id=claimed_owner_run_id or owner_run_id,
            )
    except asyncio.CancelledError:
        # 进程关闭/任务取消时保留取消语义，但清掉 active 快照，避免重启后
        # 续看端点把已不存在的后台任务误显示成「生成中」。
        await _finalize_preflight_failure(
            outcome_target, model_cfg, cancelled=True,
        )
        from app.services.conversation_pending_queue import publish_session_pending_queue_changed
        await publish_session_pending_queue_changed(
            req.user_id, session_id, origin=getattr(req, "origin", None),
        )
        raise
    except BaseException as exc:
        await _finalize_preflight_failure(
            outcome_target, model_cfg, error=exc,
        )
        from app.services.conversation_pending_queue import publish_session_pending_queue_changed
        await publish_session_pending_queue_changed(
            req.user_id, session_id, origin=getattr(req, "origin", None),
        )
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(BaseException):
            await heartbeat_task


async def _finalize_preflight_failure(target, model_cfg=None, error=None,
                                      cancelled: bool = False) -> None:
    """收口生成任务在 ``_generate_unlocked`` 之前抛出的异常。

    正常业务异常由 ``_generate_unlocked`` 自己发布并结束；这里只处理它尚未
    进入内部 ``try`` 的失败（例如能力注册表短暂不一致），并按快照状态幂等
    判断，避免重复发布错误或重复释放模型计数。
    """
    state = await genstream.snapshot(target.session_id)
    is_active = bool(state and not state.get("done"))
    import app.db.session as _sess
    from app.services.conversation_run_outcomes import build_run_outcome, persist_run_outcome

    presentation = None
    outcome = None
    if error is not None:
        logger.error(
            "Web 后台生成任务异常 session=%s error_type=%s",
            target.session_id, type(error).__name__,
            exc_info=(type(error), error, error.__traceback__),
        )
        presentation = describe_llm_error(error)
        outcome = build_run_outcome(
            status="failed",
            run_id=target.run_id,
            error_code=presentation.code,
            message_key=presentation.message_key,
            message_params=presentation.message_params,
        )
    elif cancelled:
        outcome = build_run_outcome(status="interrupted", run_id=target.run_id)

    if outcome is not None:
        await persist_run_outcome(_sess._SessionLocal, target, outcome)

    state_owner = str((state or {}).get("owner_run_id") or "")
    owns_active_run = not state_owner or state_owner == target.run_id
    if not is_active or not owns_active_run:
        # 排队任务可能在等待 session gate 时被取消。它仍要保存自己的消息结果，
        # 但不能把另一个 run 的快照广播成当前任务的失败/取消终态。
        await genstream.end(target.session_id, owner_run_id=target.run_id)
        return

    if presentation is not None and outcome is not None:
        await genstream.publish(target.session_id, {
            "run_id": target.run_id,
            "user_message_id": target.user_message_id,
            **presentation.as_event(),
            "run_outcome": outcome,
        })
    elif cancelled and outcome is not None:
        await genstream.publish(target.session_id, {
            "run_id": target.run_id,
            "user_message_id": target.user_message_id,
            "type": "done",
            "cancelled": True,
            "run_outcome": outcome,
        })

    try:
        from agent.llm.llm_select import release as _release_model
        _release_model(model_cfg)
    finally:
        await genstream.end(target.session_id, owner_run_id=target.run_id)
        from app.core import events
        await events.publish_agent_run_changed(
            target.user_id,
            session_id=target.session_id,
            status="failed" if error is not None or cancelled else "completed",
        )
