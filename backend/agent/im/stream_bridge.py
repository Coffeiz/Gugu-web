"""IM run 到 Web genstream 的镜像与终态桥接。"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from app.services.conversation_run_outcomes import (
    RunOutcomeTarget,
    build_run_outcome,
    persist_run_outcome,
)


class ImWebStreamBridge:
    """为 IM run 管理 Web 实时镜像、失败持久化和终态通知。"""

    def __init__(self, user_id: Any, session_id: int | None, platform: str) -> None:
        from agent.llm import genstream

        self.user_id = user_id
        self.session_id = session_id
        self.platform = platform
        self.owner_run_id = genstream.new_run_id()
        self.started = bool(session_id)

    async def begin(self) -> None:
        if not self.started:
            return
        from agent.llm import genstream
        from app.core import events

        await genstream.begin(self.session_id, owner_run_id=self.owner_run_id)
        # 消息 append 可能早于 begin，running 通知负责让已打开的 Web 会话接上流。
        await events.publish_agent_run_changed(
            self.user_id,
            session_id=self.session_id,
            status="running",
        )

    async def publish(self, event: dict) -> None:
        if not self.started or not isinstance(event, dict):
            return
        from agent.llm import genstream

        mirrored = dict(event)
        mirrored.setdefault("source", self.platform)
        await genstream.publish(self.session_id, mirrored)

    async def publish_failure(self, request, presentation) -> None:
        """将失败终态写到触发消息并发送同一结构化事件。"""
        outcome = build_run_outcome(
            status="failed",
            run_id=self.owner_run_id,
            error_code=presentation.code,
            message_key=presentation.message_key,
            message_params=presentation.message_params,
        )
        user_message_id = request.user_message_id
        if self.session_id is not None and user_message_id is not None:
            import app.db.session as db_session

            await persist_run_outcome(
                db_session._SessionLocal,
                RunOutcomeTarget(
                    user_id=request.user_id,
                    session_id=self.session_id,
                    user_message_id=user_message_id,
                    run_id=self.owner_run_id,
                ),
                outcome,
            )
        await self.publish({
            **presentation.as_event(),
            "user_message_id": user_message_id,
            "run_outcome": outcome,
        })

    async def mirror_stream(self, source, stream_tool_events=None):
        """镜像普通 SSE 事件；工具和交互事件由回调唯一负责发布。"""
        async def mirrored_lines():
            async for line in source:
                if isinstance(line, str) and line.startswith("data: "):
                    try:
                        event = json.loads(line[6:])
                    except (TypeError, ValueError):
                        event = None
                    if isinstance(event, dict) and event.get("type") not in {
                        "done", "error", "tool_call", "tool_done", "interaction_required",
                    }:
                        await self.publish(event)
                yield line

        if stream_tool_events is None:
            async for line in mirrored_lines():
                yield line
            return

        async def pump_source():
            try:
                async for line in mirrored_lines():
                    await stream_tool_events.put(("stream", line))
            except BaseException as exc:
                await stream_tool_events.put(("error", exc))
            finally:
                await stream_tool_events.put(("end", None))

        producer = asyncio.create_task(pump_source())
        try:
            while True:
                kind, value = await stream_tool_events.get()
                if kind == "end":
                    break
                if kind == "error":
                    raise value
                if kind == "tool":
                    yield ("tool_event", value)
                else:
                    yield value
        finally:
            if not producer.done():
                producer.cancel()
            try:
                await producer
            except asyncio.CancelledError:
                pass

    async def finish(self, *, failed: bool) -> None:
        if not self.started:
            return
        from agent.llm import genstream
        from app.core import events
        from app.services.conversation_pending_queue import publish_session_pending_queue_changed

        if not failed:
            await self.publish({"type": "done", "source": self.platform})
        await genstream.end(self.session_id, owner_run_id=self.owner_run_id)
        await events.publish_agent_run_changed(
            self.user_id,
            session_id=self.session_id,
            status="failed" if failed else "completed",
        )
        await publish_session_pending_queue_changed(self.user_id, self.session_id)
