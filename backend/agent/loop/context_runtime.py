"""Agent Loop 的上下文压缩生命周期协调。

预算规则和压缩/裁切算法仍分别由 ``rounds`` 与 ``agent.context`` 持有；本模块只
协调单次 run 的保护边界、取消心跳、结果回写、reasoning 边界和压缩事件。
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from agent.context import budget, compaction
from agent.context.assembly.area import MessageArea
from agent.loop.models import RunState
from agent.loop.rounds import remap_round_start_indices, rolling_compaction_start_index
from agent.loop.rounds import usage_compaction_due as is_usage_compaction_due
from agent.runtime.cancellation import RunCancellation, RunCancellationRequested

_log = logging.getLogger("agent.core")


@dataclass
class ContextRuntime:
    """一轮 run 的上下文维护状态；不持有 Provider 调用或工具调度职责。"""

    messages: MessageArea
    run_state: RunState
    ai: Any
    system_text: str | None
    session_id: int | None
    run_start_index: int
    branch_tools: Any = None
    reasoning_state: Any = None
    last_no_progress_length: int | None = None
    provider_compacted: bool = False
    pending_event: dict[str, Any] | None = field(default=None, init=False)

    def _protected_from(self) -> int:
        index = rolling_compaction_start_index(
            self.run_state.round_start_indices,
            self.run_state.round_number,
        )
        return self.run_start_index if index is None else index

    async def compact_now(self) -> bool:
        """请求摘要压缩并把压缩后的 baseline 原子写回 MessageArea。"""
        from agent.llm import genstream

        async def keep_generation_alive() -> None:
            if not self.session_id:
                return
            wakeup = asyncio.Event()
            while True:
                await genstream.touch(self.session_id)
                try:
                    await asyncio.wait_for(wakeup.wait(), timeout=30)
                except asyncio.TimeoutError:
                    continue

        heartbeat = asyncio.create_task(keep_generation_alive())
        conversation = self.messages.provider_projection().to_messages()
        before_count = len(conversation)
        before_summary = [
            item for item in conversation
            if isinstance(item, dict) and "<compacted-summary>" in str(item.get("content") or "")
        ]
        protected_from = self._protected_from()
        area_revision = self.messages.revision
        try:
            try:
                result = await RunCancellation(self.session_id).dispatch(
                    lambda: compaction.compact_context(
                        self.messages,
                        session_id=self.session_id,
                        fixed_prefix_size=self.messages.fixed_prefix_size,
                        protected_from=protected_from,
                        protected_anchor_index=self.run_start_index,
                        protected_previous_from=self.messages.protected_history_start,
                        model_cfg=self.ai,
                        system_text=self.system_text,
                        branch_tools=self.branch_tools,
                    ),
                    request_id=None,
                )
            except RunCancellationRequested:
                raise
            except Exception as exc:
                from app.core.redaction import diag_log

                diag_log("agent.context.compaction.summary", exc)
                _log.warning("上下文压缩失败，继续使用确定性截断：%s", type(exc).__name__)
                return False
        finally:
            heartbeat.cancel()
            try:
                await heartbeat
            except asyncio.CancelledError:
                pass

        if hasattr(result, "messages"):
            compacted_messages, changed = result.messages, result.changed
        else:
            compacted_messages, changed = result
        after_summary = [
            item for item in compacted_messages
            if isinstance(item, dict) and "<compacted-summary>" in str(item.get("content") or "")
        ]
        try:
            from agent.runtime.loopscope_trace.state import record_context_compaction

            record_context_compaction(
                phase="completed",
                reason=str(getattr(result, "return_reason", "unknown") or "unknown"),
                changed=bool(changed),
                before_messages=before_count,
                after_messages=len(compacted_messages),
                before_summary_count=len(before_summary),
                after_summary_count=len(after_summary),
                before_summary_chars=sum(len(str(item.get("content") or "")) for item in before_summary),
                after_summary_chars=sum(len(str(item.get("content") or "")) for item in after_summary),
                protected_from=protected_from,
            )
        except Exception:
            pass
        if not changed:
            return False

        self.provider_compacted = True
        self.messages.replace_request_baseline(compacted_messages, expected_revision=area_revision)
        anchor_index = getattr(result, "anchor_index", None)
        if anchor_index is not None:
            self.run_start_index = anchor_index
        protected_start_index = getattr(result, "protected_start_index", None)
        if protected_start_index is not None:
            protected_source_start = getattr(result, "protected_source_start_index", None)
            if protected_source_start is None:
                protected_source_start = protected_from
            self.run_state.round_start_indices[:] = remap_round_start_indices(
                self.run_state.round_start_indices,
                protected_start_index,
                protected_source_start,
            )
        self.last_no_progress_length = None
        if self.reasoning_state is not None:
            await self.reasoning_state.boundary_changed("baseline_changed")
        self.pending_event = {
            "type": "_context_compaction",
            "phase": "completed",
            "applied": True,
            "reason": getattr(result, "return_reason", "compacted"),
        }
        return True

    async def apply_deterministic_fallback(self, reason: str) -> bool:
        """摘要压缩未生效时裁切超限上下文，并同步更新保护索引。"""
        protected_from = self._protected_from()
        result = budget.enforce_provider_overflow_fallback(
            self.messages,
            self.system_text or "",
            getattr(self.ai, "context_tokens", 256000),
            protected_from=protected_from,
            protected_anchor_index=self.run_start_index,
        )
        if not result.changed:
            return False

        self.provider_compacted = True
        anchor_index = getattr(result, "anchor_index", None)
        if anchor_index is not None:
            self.run_start_index = anchor_index
        protected_start_index = getattr(result, "protected_start_index", None)
        if protected_start_index is not None:
            protected_source_start = getattr(result, "protected_source_start_index", None)
            if protected_source_start is None:
                protected_source_start = protected_from
            self.run_state.round_start_indices[:] = remap_round_start_indices(
                self.run_state.round_start_indices,
                protected_start_index,
                protected_source_start,
            )
        self.last_no_progress_length = None
        if self.reasoning_state is not None:
            await self.reasoning_state.boundary_changed("baseline_changed")
        self.pending_event = {
            "type": "_context_compaction",
            "phase": "completed",
            "applied": True,
            "reason": reason,
        }
        return True

    def usage_compaction_due(self) -> bool:
        conversation = self.messages.provider_projection().to_messages()
        return is_usage_compaction_due(
            run_context_usage=self.run_state.run_context_usage,
            context_tokens=int(getattr(self.ai, "context_tokens", 0) or 0),
            no_progress=self.last_no_progress_length == len(conversation),
        )

    async def compact_after_usage_threshold(self) -> bool:
        """达到实际 provider usage 阈值时执行摘要或确定性裁切。"""
        if not self.usage_compaction_due():
            return False
        if await self.compact_now():
            return True
        if await self.apply_deterministic_fallback("usage_threshold_fallback"):
            _log.warning("provider usage 达到 90% 但摘要压缩未生效，执行确定性裁切")
            return True
        self.last_no_progress_length = len(self.messages.provider_projection())
        _log.error("provider usage 达到 90%，摘要和确定性裁切均未生效")
        return False

    def take_event(self) -> dict[str, Any] | None:
        event, self.pending_event = self.pending_event, None
        return event
