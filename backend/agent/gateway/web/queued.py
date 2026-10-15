"""Web Gateway queued 实现。"""
from __future__ import annotations
import asyncio
import json
import logging
from agent.llm import genstream
logger = logging.getLogger(__name__)
_QUEUED_RUN_MAX_WAIT_SECONDS = 900.0
_QUEUED_RUN_POLL_INTERVAL_SECONDS = 1.0
_QUEUED_RUN_PING_INTERVAL_SECONDS = 15.0


async def _stream_queued_run(session_id: int, owner_run_id: str, task: asyncio.Task,
                             pubsub=None):
    """排队请求的 SSE：声明排队后等自己的 run 开始，再把它的事件转发出去。

    订阅在 ``stream()`` 开头「先订阅后启动」时建立并一路保持：pub/sub 发完即弃，
    begin 之后、轮询确认归属之前 publish 的事件全部躺在连接缓冲里，不存在「接管
    之后才订阅」的丢失窗口（否则一个很快的排队回复会生成完毕但界面只有后半截）。
    本 run 的每个事件都带 ``owner_run_id``（``_generate_unlocked._pub`` 统一注入），
    第一个带本 run 标记的事件即接管点：之前的频道事件属于旧 run（含它的 done），
    一律不转发也不终止本连接；之后的事件全数转发到终态。轮询只做兜底：错过终态
    事件时按快照补 done、任务未接管即结束收 idle、心跳与最长等待上限。
    """
    yield f"data: {json.dumps({'type': 'queued', 'run_id': owner_run_id})}\n\n"
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _QUEUED_RUN_MAX_WAIT_SECONDS
    last_ping = loop.time()
    owned = False
    if pubsub is None:
        pubsub = await genstream.open_subscription(session_id)

    def _process(message) -> tuple[str | None, bool]:
        """解析一条频道消息，返回 (要转发的 SSE 行, 是否已归属本 run 的终态)。

        接管判定：第一个带本 run 标记的事件。此前频道上的事件都属于旧 run
        （或未标记归属的系统提示），转发会污染本条消息的回答——丢弃，也
        不因它们的 done/error 终止本连接。
        """
        nonlocal owned
        data = message.get("data")
        try:
            event = json.loads(data)
        except (TypeError, ValueError):
            return None, False
        if not owned:
            if event.get("run_id") != owner_run_id:
                return None, False
            owned = True
        return f"data: {data}\n\n", event.get("type") in ("done", "error")

    try:
        while True:
            try:
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=_QUEUED_RUN_POLL_INTERVAL_SECONDS,
                )
            except Exception:
                msg = None
            if msg is not None and msg.get("data"):
                line, terminal = _process(msg)
                if line is not None:
                    yield line
                if terminal:
                    return
                continue
            now = loop.time()
            snap = await genstream.snapshot(session_id)
            # genstream.publish 的顺序是「先写快照、后广播」：快照可能领先于
            # 连接缓冲里还没消费的事件。依据快照做任何兜底判定之前必须先把
            # 缓冲清干，否则会把已排队的事件误判成丢失、提前收口（慢负载下
            # 可复现的抢跑）。
            drained = False
            while True:
                try:
                    pending = await pubsub.get_message(
                        ignore_subscribe_messages=True, timeout=0,
                    )
                except Exception:
                    break
                if pending is None or not pending.get("data"):
                    break
                drained = True
                line, terminal = _process(pending)
                if line is not None:
                    yield line
                if terminal:
                    return
            if drained:
                continue
            if owned and snap and snap.get("done"):
                # 终态事件丢了（Redis 抖动等）：快照是权威结果，补发 done 让
                # 前端正常收口，不制造中断气泡。
                yield f"data: {json.dumps({'type': 'done', 'replayed': True})}\n\n"
                return
            if not owned and task.done():
                # 后台任务已结束但快照从未归属过本 run：任务在门上排队期间被取消、
                # 或 preflight 失败。转发不到任何事件了，让前端走 DB 加载收口。
                yield f"data: {json.dumps({'type': 'done', 'idle': True})}\n\n"
                return
            if not owned and snap and snap.get("done") \
                    and snap.get("owner_run_id") == owner_run_id:
                # run 在任何事件前就结束（排队中被取消等）：快照已是本 run 归属
                # 且终态，补发终态让前端收口。
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                return
            if now - last_ping >= _QUEUED_RUN_PING_INTERVAL_SECONDS:
                yield ": ping\n\n"
                last_ping = now
            if now >= deadline:
                logger.warning("[web] session=%s 排队 run=%s 等待超时，SSE 收口", session_id, owner_run_id)
                yield f"data: {json.dumps({'type': 'done', 'idle': True})}\n\n"
                return
    finally:
        await genstream.close_subscription(session_id, pubsub)
