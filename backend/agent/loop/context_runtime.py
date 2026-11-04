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
from agent.runtime.cancellation import current_cancellation, RunCancellationRequested

_log = logging.getLogger("agent.core")
# 仅在实际用量达阈值或明确溢出后缩小保留窗口；普通历史恢复仍保留十轮。
_PRESSURE_KEEP_ROUNDS = 1


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

    def _protected_from(self, keep_rounds: int = _PRESSURE_KEEP_ROUNDS) -> int:
        index = rolling_compaction_start_index(
            self.run_state.round_start_indices,
            self.run_state.round_number,
            keep_rounds=keep_rounds,
        )
        return self.run_start_index if index is None else index

    async def compact_now(
        self, *, keep_rounds: int = _PRESSURE_KEEP_ROUNDS,
        preserve_previous_run: bool = False,
    ) -> bool:
        """摘要较早执行轮，原样保留用户锚点和最近完整轮，再原子更新 Area。"""
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
        protected_from = self._protected_from(keep_rounds)
        area_revision = self.messages.revision
        try:
            try:
                result = await current_cancellation(self.session_id).dispatch(
                    lambda: compaction.compact_context(
                        self.messages,
                        session_id=self.session_id,
                        fixed_prefix_size=self.messages.fixed_prefix_size,
                        protected_from=protected_from,
                        protected_anchor_index=self.run_start_index,
                        protected_previous_from=(
                            self.messages.protected_history_start if preserve_previous_run else None
                        ),
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
                _log.warning("上下文压缩失败，本次不替换历史：%s", type(exc).__name__)
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
        # 这些位置属于压缩前的投影；上一 run 的保护窗口也必须随 baseline 迁移，
        # 否则下一轮会把仍需保留的历史重新摘要，并再次改变缓存前缀。
        self.messages.protected_history_start = getattr(result, "previous_protected_start_index", None)
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
        self.messages.protected_history_start = result.previous_protected_start_index
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
        """达到实际用量阈值时摘要旧历史；硬裁切只允许用于明确的上游溢出。"""
        if not self.usage_compaction_due():
            return False
        if await self.compact_now():
            return True
        self.last_no_progress_length = len(self.messages.provider_projection())
        _log.info("provider usage 达到 90%，本次摘要未应用，保留当前历史窗口")
        return False

    def take_event(self) -> dict[str, Any] | None:
        event, self.pending_event = self.pending_event, None
        return event
