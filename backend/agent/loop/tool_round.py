"""Agent Loop 工具轮次执行片段。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, AsyncGenerator

from agent.interactions.confirmations import confirmation_payload
from agent.loop.events import artifact_sse
from agent.request_headers import redact_tool_request_headers

_log = logging.getLogger("agent.traj")


def _tool_input_signature(tool_name: str, arguments: Any) -> str | None:
    """为本轮失败的工具参数生成不含原文的短期指纹。"""
    try:
        encoded = json.dumps(
            [tool_name, arguments], ensure_ascii=False, sort_keys=True,
            separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError):
        return None
    return hashlib.sha256(encoded).hexdigest()


def _is_schema_rejection(result: Any, json_loads: Any) -> bool:
    try:
        payload = json_loads(result) if isinstance(result, str) else result
    except (TypeError, ValueError):
        return False
    return isinstance(payload, dict) and payload.get("error") == "tool_input_invalid"


def _pending_interaction_kind(tool_name: str, result: Any) -> str | None:
    if confirmation_payload(result) is not None:
        return "confirmation"
    if tool_name not in {"ask_user", "manage_mcp_servers"}:
        return None
    payload = result
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            return None
    return "ask_user" if isinstance(payload, dict) and payload.get("_interaction") == "ask_user" else None


@dataclass(frozen=True)
class ParallelToolBindings:
    """由稳定 loop wrapper 注入的少量兼容点，保留现有 monkeypatch 契约。"""

    set_tool_state: Any
    dispatch_in_session: Any
    copy_skill_state: Any
    run_parallel_dispatches: Any
    dispatch_cancelled_type: type[BaseException]
    is_successful_result: Any
    diag_log: Any
    log_batch: Any


@dataclass(frozen=True)
class ToolRoundEmission:
    kind: str
    value: Any


@dataclass(frozen=True)
class ParallelToolBatchOutcome:
    dispatched: list[tuple[Any, Any]]
    cancelled: bool


@dataclass
class ParallelToolBatchRuntime:
    """并行工具批次的事件顺序、取消结算和结果归一。"""

    tool_calls: list[Any]
    parallel_batch: list[tuple[int, Any, str, dict[str, Any]]]
    protocol_errors: dict[int, tuple[str, str]]
    runner: Any
    user_id: Any
    session_id: int | None
    session: Any
    run_id: str
    round_id: str
    verify_mode: bool
    tool_snapshot: Any
    loaded_skill_ids: dict[str, str]
    max_concurrency: int
    bindings: ParallelToolBindings
    run_state: Any = None
    on_interaction: Any = None

    async def run(self) -> AsyncGenerator[ToolRoundEmission, None]:
        parallel_meta: list[tuple[int, Any, str, dict[str, Any], str, str, str]] = []
        prepared_by_index = {
            index: (call, target, arguments)
            for index, call, target, arguments in self.parallel_batch
        }
        invalid_meta: dict[int, tuple[Any, str, str, str, str]] = {}

        for original_index, call in enumerate(self.tool_calls):
            if original_index in self.protocol_errors:
                effective_name, protocol_result = self.protocol_errors[original_index]
                label = self.runner._label(effective_name)
                if self.verify_mode:
                    label = self.runner._label("_verify_prefix", "复查 · ") + label
                tool_call_id = getattr(call, "id", None) or f"{self.round_id}-tool-{original_index + 1}"
                invalid_meta[original_index] = (
                    call, effective_name, label, tool_call_id, protocol_result,
                )
                yield ToolRoundEmission("event", {
                    "type": "tool_call", "round_id": self.round_id,
                    "tool_call_id": tool_call_id, "name": effective_name,
                    "label": label, "input": {}, "verify": self.verify_mode,
                    "status": "invalid",
                })
                continue

            call, dispatch_target, dispatch_input = prepared_by_index[original_index]
            effective_name = dispatch_target
            label = self.runner._label(effective_name)
            if self.verify_mode:
                label = self.runner._label("_verify_prefix", "复查 · ") + label
            tool_call_id = getattr(call, "id", None) or f"{self.round_id}-tool-{original_index + 1}"
            yield ToolRoundEmission("event", {
                "type": "tool_call", "round_id": self.round_id,
                "tool_call_id": tool_call_id, "name": effective_name,
                "label": label, "input": redact_tool_request_headers(dispatch_input),
                "verify": self.verify_mode, "status": "queued",
            })
            parallel_meta.append((
                original_index, call, dispatch_target, dispatch_input,
                effective_name, label, tool_call_id,
            ))

        parallel_meta_by_index = {item[0]: item for item in parallel_meta}
        started_calls: asyncio.Queue[tuple[int, asyncio.Future[None]] | None] = asyncio.Queue()
        dispatch_task: asyncio.Task | None = None
        parallel_cancelled = False
        parallel_results: list[Any] = []

        async def dispatch_one(call):
            original_index, _tool_call, target, arguments = call
            meta = parallel_meta_by_index[original_index]
            await self.bindings.set_tool_state(meta[4])
            acknowledged = asyncio.get_running_loop().create_future()
            started_calls.put_nowait((original_index, acknowledged))
            await acknowledged
            from agent.tools.base import parallel_dispatch_context

            with parallel_dispatch_context():
                return await self.bindings.dispatch_in_session(
                    self.user_id,
                    target,
                    arguments,
                    session_id=self.session_id,
                    session=self.session,
                    run_id=self.run_id,
                    tool_snapshot=self.tool_snapshot,
                    skill_state=self.bindings.copy_skill_state(self.loaded_skill_ids),
                    tool_call_id=meta[6],
                )

        async def dispatch_batch():
            try:
                return await self.bindings.run_parallel_dispatches(
                    self.parallel_batch,
                    dispatch_one,
                    max_concurrency=self.max_concurrency,
                )
            except self.bindings.dispatch_cancelled_type as exc:
                return exc
            finally:
                started_calls.put_nowait(None)

        started_at = time.monotonic()
        dispatch_task = asyncio.create_task(dispatch_batch())
        try:
            while True:
                started = await started_calls.get()
                if started is None:
                    break
                original_index, acknowledged = started
                meta = parallel_meta_by_index[original_index]
                if not acknowledged.done():
                    acknowledged.set_result(None)
                yield ToolRoundEmission("event", {
                    "type": "tool_call", "round_id": self.round_id,
                    "tool_call_id": meta[6], "name": meta[4], "label": meta[5],
                    "input": redact_tool_request_headers(meta[3]),
                    "verify": self.verify_mode, "status": "running",
                })
            parallel_results = await dispatch_task
            if isinstance(parallel_results, self.bindings.dispatch_cancelled_type):
                parallel_cancelled = True
                parallel_results = parallel_results.results
        except asyncio.CancelledError:
            if dispatch_task is not None and not dispatch_task.done():
                dispatch_task.cancel()
            settled = await asyncio.gather(dispatch_task, return_exceptions=True)
            cancellation = settled[0] if settled else None
            if isinstance(cancellation, self.bindings.dispatch_cancelled_type):
                parallel_results = cancellation.results
                parallel_cancelled = True
            else:
                raise
        except self.bindings.dispatch_cancelled_type as exc:
            parallel_results = exc.results
            parallel_cancelled = True
        finally:
            if dispatch_task is not None and not dispatch_task.done():
                dispatch_task.cancel()
                await asyncio.gather(dispatch_task, return_exceptions=True)

        succeeded = failed = cancelled = waiting = 0
        results_by_index: dict[int, tuple[Any, Any]] = {}
        for meta, dispatched_result in zip(parallel_meta, parallel_results):
            original_index = meta[0]
            if isinstance(dispatched_result, asyncio.CancelledError):
                cancelled += 1
                results_by_index[original_index] = (dispatched_result, None)
            elif isinstance(dispatched_result, Exception):
                failed += 1
                results_by_index[original_index] = (dispatched_result, None)
            else:
                result_payload = dispatched_result[0]
                if _pending_interaction_kind(meta[4], result_payload) is not None:
                    waiting += 1
                elif not self.bindings.is_successful_result(result_payload):
                    failed += 1
                else:
                    succeeded += 1
                results_by_index[original_index] = dispatched_result

        self.bindings.log_batch({
            "mode": "parallel",
            "calls": len(self.parallel_batch),
            "isolated_invalid": len(self.protocol_errors),
            "reason": "same_round_batch",
            "elapsed_ms": round((time.monotonic() - started_at) * 1000),
            "succeeded": succeeded,
            "failed": failed,
            "cancelled": cancelled,
        })

        dispatched: list[tuple[Any, Any]] = []
        for original_index, call in enumerate(self.tool_calls):
            if original_index in invalid_meta:
                _call, effective_name, label, tool_call_id, result = invalid_meta[original_index]
                yield ToolRoundEmission("event", {
                    "type": "tool_done", "round_id": self.round_id,
                    "tool_call_id": tool_call_id, "name": effective_name,
                    "label": label, "verify": self.verify_mode,
                    "status": "error", "result": result,
                })
                dispatched.append((call, result))
                continue

            meta = parallel_meta_by_index[original_index]
            _index, call, _target, _arguments, effective_name, label, tool_call_id = meta
            result, artifact, status, pending_emissions = await self._settle_call_result(
                meta, results_by_index[original_index],
            )
            for emission in pending_emissions:
                yield emission
                if emission.kind == "event" and self.on_interaction is not None:
                    payload = emission.value
                    if payload.get("type") == "interaction_required":
                        await self.on_interaction({
                            key: value for key, value in payload.items() if key != "type"
                        })
            yield ToolRoundEmission("event", {
                "type": "tool_done", "round_id": self.round_id,
                "tool_call_id": tool_call_id, "name": effective_name,
                "label": label, "verify": self.verify_mode, "status": status,
                "result": result,
            })
            if artifact:
                yield ToolRoundEmission("artifact", artifact)
            dispatched.append((call, result))

        yield ToolRoundEmission(
            "complete",
            ParallelToolBatchOutcome(dispatched=dispatched, cancelled=parallel_cancelled),
        )

    async def _create_interaction(self, item: dict[str, Any]) -> dict[str, Any] | None:
        from app.services.interactions import create_tool_interaction

        return await create_tool_interaction(
            user_id=self.user_id,
            session_id=self.session_id,
            tool_name=item["tool_name"],
            tool_call_id=item["tool_call_id"],
            result=item["result"],
            kind=item["kind"],
        )

    @staticmethod
    def _interaction_unavailable_result() -> str:
        return json.dumps({
            "error": (
                "该工具需要用户交互，但系统未能创建交互请求；本次操作未继续。"
                "请在有效的 Web 或 IM 对话中重新发起。"
            ),
            "interaction_unavailable": True,
        }, ensure_ascii=False)

    async def _settle_call_result(
        self, meta: tuple, dispatched_result: Any,
    ) -> tuple[Any, Any, str, list[ToolRoundEmission]]:
        """归一单项结果，并独立处理该调用触发的交互门。"""
        _index, _call, target, arguments, name, label, tool_call_id = meta
        result, artifact = dispatched_result
        if isinstance(result, asyncio.CancelledError):
            return json.dumps({"error": "工具调用已取消。"}, ensure_ascii=False), None, "cancelled", []
        if isinstance(result, Exception):
            self.bindings.diag_log("agent.loop.parallel_tool_dispatch", result)
            return json.dumps({"error": "工具执行失败，请稍后重试。"}, ensure_ascii=False), None, "error", []

        if name == "use_skill" and self.bindings.is_successful_result(result):
            try:
                skill_result = json.loads(result) if isinstance(result, str) else result
            except (TypeError, ValueError):
                skill_result = None
            marker = skill_result.get("_capability_usage") if isinstance(skill_result, dict) else None
            digest = marker.get("content_digest") if isinstance(marker, dict) else None
            skill_id = str((arguments or {}).get("id") or "").strip().upper()
            if skill_id and isinstance(digest, str) and digest:
                self.loaded_skill_ids[skill_id] = digest

        kind = _pending_interaction_kind(name, result)
        if kind is None:
            status = "success" if self.bindings.is_successful_result(result) else "error"
            return result, artifact, status, []

        item = {
            "kind": kind, "result": result, "tool_call_id": tool_call_id,
            "tool_name": name, "label": label, "target": target,
            "input": arguments, "round_id": self.round_id,
            "verify": self.verify_mode,
        }
        if self.run_state is None:
            return self._interaction_unavailable_result(), None, "error", []
        if self.run_state.pending is not None:
            self.run_state.pending_tool_interactions.append(item)
            if kind == "ask_user":
                result = json.dumps({"status": "waiting_input"}, ensure_ascii=False)
            return result, artifact, "waiting", []

        interaction = await self._create_interaction(item)
        if interaction is None:
            return self._interaction_unavailable_result(), None, "error", []
        from agent.loop.models import PendingInteraction

        replay = None
        if kind == "confirmation":
            replay = {"name": name, "label": label, "target": target, "input": arguments}
        self.run_state.pending = PendingInteraction(
            interaction["prompt_id"], tool_call_id, name, replay,
        )
        if kind == "ask_user":
            result = json.dumps({
                "status": "waiting_input", "prompt_id": interaction["prompt_id"],
            }, ensure_ascii=False)
        payload = {
            **interaction, "round_id": self.round_id,
            "tool_call_id": tool_call_id,
        }
        return result, artifact, "waiting", [ToolRoundEmission("event", {
            "type": "interaction_required", **payload,
        })]


@dataclass(frozen=True)
class SerialToolBindings:
    """串行工具执行所需的底层能力；策略和授权仍由现有 dispatch 提供。"""

    resolve_tool_call: Any
    set_tool_state: Any
    dispatch_in_session: Any
    is_successful_result: Any
    json_dumps: Any
    json_loads: Any
    pending_interaction_type: Any
    truncated_args_error: str


@dataclass(frozen=True)
class SerialToolBatchOutcome:
    dispatched: list[tuple[Any, Any]]


@dataclass
class SerialToolBatchRuntime:
    """执行单个串行工具批次，产出有序事件并保留交互挂起状态。"""

    tool_calls: list[Any]
    runner: Any
    run_state: Any
    bindings: SerialToolBindings
    user_id: Any
    session_id: int | None
    session: Any
    run_id: str
    round_id: str
    verify_mode: bool
    tool_snapshot: Any
    loaded_skill_ids: dict[str, str]
    on_interaction: Any = None

    async def run(self) -> AsyncGenerator[ToolRoundEmission, None]:
        dispatched: list[tuple[Any, Any]] = []
        interaction_call_index: int | None = None
        for call_index, tool_call in enumerate(self.tool_calls):
            raw_call_name = getattr(tool_call, "name", None)
            dispatch_target, dispatch_input, protocol_error = self.bindings.resolve_tool_call(
                raw_call_name, getattr(tool_call, "input", None),
            )
            effective_name = dispatch_target
            if effective_name != "invalid_tool_call" and self.tool_snapshot.get(effective_name) is None:
                from agent.tools.base import salvage_tool_name

                salvaged = salvage_tool_name(effective_name)
                if salvaged is not None and self.tool_snapshot.get(salvaged) is not None:
                    logging.getLogger("agent.core").info(
                        "工具名污染兜底：%r → %r", effective_name, salvaged,
                    )
                    if raw_call_name == "call_tool":
                        dispatch_target = salvaged
                    else:
                        tool_call.name = salvaged
                        dispatch_target = salvaged
                    effective_name = salvaged

            label = self.runner._label(effective_name)
            if self.verify_mode:
                label = self.runner._label("_verify_prefix", "复查 · ") + label
            tool_call_id = getattr(tool_call, "id", None) or f"{self.round_id}-tool-{call_index + 1}"
            self.run_state.tool_call_count += 1

            def emit(event_type: str, **payload: Any) -> ToolRoundEmission:
                if event_type == "tool_call" and "input" in payload:
                    payload["input"] = redact_tool_request_headers(payload["input"])
                return ToolRoundEmission("event", {"type": event_type, **payload})

            if protocol_error is not None:
                yield emit(
                    "tool_call", round_id=self.round_id, tool_call_id=tool_call_id,
                    name=effective_name, label=label, input={}, verify=self.verify_mode,
                    status="invalid",
                )
                dispatched.append((tool_call, self.bindings.json_dumps(protocol_error, ensure_ascii=False)))
                yield emit(
                    "tool_done", round_id=self.round_id, tool_call_id=tool_call_id,
                    name=effective_name, label=label, verify=self.verify_mode,
                    status="error", result=dispatched[-1][1],
                )
                continue

            if getattr(tool_call, "parse_error", None):
                yield emit(
                    "tool_call", round_id=self.round_id, tool_call_id=tool_call_id,
                    name=effective_name, label=label, input={}, verify=self.verify_mode,
                    status="invalid",
                )
                dispatched.append((tool_call, self.bindings.truncated_args_error))
                yield emit(
                    "tool_done", round_id=self.round_id, tool_call_id=tool_call_id,
                    name=effective_name, label=label, verify=self.verify_mode,
                    status="error", result=self.bindings.truncated_args_error,
                )
                continue

            input_signature = _tool_input_signature(effective_name, dispatch_input)
            if input_signature and input_signature in self.run_state.invalid_tool_input_signatures:
                repeated_result = self.bindings.json_dumps({
                    "error": "本轮中相同的无效工具参数已被拦截，没有再次执行。",
                    "next_action": (
                        "停止重复提交相同参数；按上次 schema 错误修正字段或先取得缺失信息，"
                        "目标仍不明确时询问用户。修正后再调用工具。"
                    ),
                }, ensure_ascii=False)
                yield emit(
                    "tool_call", round_id=self.round_id, tool_call_id=tool_call_id,
                    name=effective_name, label=label, input=dispatch_input,
                    verify=self.verify_mode, status="invalid",
                )
                dispatched.append((tool_call, repeated_result))
                yield emit(
                    "tool_done", round_id=self.round_id, tool_call_id=tool_call_id,
                    name=effective_name, label=label, verify=self.verify_mode,
                    status="error", result=repeated_result,
                )
                continue

            await self.bindings.set_tool_state(effective_name)
            yield emit(
                "tool_call", round_id=self.round_id, tool_call_id=tool_call_id,
                name=effective_name, label=label, input=dispatch_input,
                verify=self.verify_mode, status="running",
            )

            skill_id = None
            if effective_name == "use_skill":
                skill_id = str((dispatch_input or {}).get("id") or "").strip().upper()
            current_digest = None
            capability = self.runner.capability_context
            if skill_id:
                if capability is not None:
                    current_digest = capability.skill_digest(skill_id)
                if not current_digest:
                    from agent.skills import skill_content_digest

                    current_digest = skill_content_digest(skill_id)
            skill_meta = capability.skill_meta(skill_id) if skill_id and capability is not None else None
            is_user_skill = bool(skill_meta and skill_meta.source == "user")
            if skill_id and current_digest and self.loaded_skill_ids.get(skill_id) == current_digest and not is_user_skill:
                skill_name = (skill_meta.display_name or skill_id) if skill_meta else skill_id
                result = self.bindings.json_dumps({
                    "skill_id": skill_id,
                    "skill_name": skill_name,
                    "already_loaded": True,
                    "message": f"技能「{skill_name}」的正文已在当前上下文中，无需重复加载。",
                }, ensure_ascii=False)
                artifact = None
            else:
                result, artifact = await self.bindings.dispatch_in_session(
                    self.user_id, dispatch_target, dispatch_input,
                    session_id=self.session_id, session=self.session, run_id=self.run_id,
                    tool_snapshot=self.tool_snapshot, skill_state=self.loaded_skill_ids,
                    tool_call_id=tool_call_id,
                )
                if input_signature and _is_schema_rejection(result, self.bindings.json_loads):
                    self.run_state.invalid_tool_input_signatures.add(input_signature)
                if skill_id and self.bindings.is_successful_result(result):
                    try:
                        payload = self.bindings.json_loads(result) if isinstance(result, str) else result
                    except (TypeError, ValueError):
                        payload = None
                    marker = payload.get("_capability_usage") if isinstance(payload, dict) else None
                    digest = marker.get("content_digest") if isinstance(marker, dict) else None
                    if isinstance(digest, str) and digest:
                        self.loaded_skill_ids[skill_id] = digest
                    elif current_digest:
                        self.loaded_skill_ids[skill_id] = current_digest

            if _pending_interaction_kind(effective_name, result) == "ask_user":
                from app.services.interactions import create_tool_interaction

                interaction = await create_tool_interaction(
                    user_id=self.user_id, session_id=self.session_id,
                    tool_name=effective_name, tool_call_id=tool_call_id,
                    result=result, kind="ask_user",
                )
                if interaction is not None:
                    pending_result = self.bindings.json_dumps({
                        "status": "waiting_input", "prompt_id": interaction["prompt_id"],
                    }, ensure_ascii=False)
                    dispatched.append((tool_call, pending_result))
                    self.run_state.pending = self.bindings.pending_interaction_type(
                        interaction["prompt_id"], tool_call_id, effective_name,
                    )
                    yield emit(
                        "tool_done", round_id=self.round_id, tool_call_id=tool_call_id,
                        name=effective_name, label=label, verify=self.verify_mode,
                        status="waiting", result=pending_result,
                    )
                    interaction_payload = {
                        **interaction,
                        "round_id": self.round_id, "tool_call_id": tool_call_id,
                    }
                    yield emit("interaction_required", **interaction_payload)
                    if self.on_interaction is not None:
                        await self.on_interaction(interaction_payload)
                    interaction_call_index = call_index
                    break

            from app.services.interactions import create_tool_interaction

            interaction = await create_tool_interaction(
                user_id=self.user_id, session_id=self.session_id,
                tool_name=effective_name, tool_call_id=tool_call_id, result=result,
                kind="confirmation",
            )
            if interaction:
                self.run_state.pending = self.bindings.pending_interaction_type(
                    interaction["prompt_id"], tool_call_id, effective_name,
                    {
                        "name": effective_name, "label": label,
                        "target": dispatch_target, "input": dispatch_input,
                    },
                )
                dispatched.append((tool_call, result))
                yield emit(
                    "interaction_required", round_id=self.round_id,
                    tool_call_id=tool_call_id, **interaction,
                )
                if self.on_interaction is not None:
                    await self.on_interaction({
                        **interaction, "round_id": self.round_id,
                        "tool_call_id": tool_call_id,
                    })
                yield emit(
                    "tool_done", round_id=self.round_id, tool_call_id=tool_call_id,
                    name=effective_name, label=label, verify=self.verify_mode,
                    status="waiting", result=result,
                )
                interaction_call_index = call_index
                break

            # 确认载荷只有成功创建交互事件后才能作为“等待用户确认”返回给模型。
            # 后台定时任务没有交互 session，或确认桥接未能创建事件时，原样返回
            # needs_confirm 会让模型误以为用户已收到确认按钮。工具确认门此时尚未
            # 执行操作，因此改为明确失败结果，让模型和后续投递都知道需要用户在
            # 有效的 Web/IM 会话中重新发起。
            if confirmation_payload(result) is not None:
                result = self.bindings.json_dumps({
                    "error": (
                        "该操作需要用户确认，但系统未能创建可交互的确认请求，"
                        "当前定时任务无法向任何对话会话发起确认，操作未执行。"
                        "请告知用户由用户本人在 Web 或 IM 对话中重新发起。"
                    ),
                    "confirmation_unavailable": True,
                }, ensure_ascii=False)

            dispatched.append((tool_call, result))
            yield emit(
                "tool_done", round_id=self.round_id, tool_call_id=tool_call_id,
                name=effective_name, label=label, verify=self.verify_mode,
                status="success" if self.bindings.is_successful_result(result) else "error",
                result=result,
            )
            if artifact:
                yield ToolRoundEmission("artifact", artifact)

        if interaction_call_index is not None:
            emissions, deferred_results = self._defer_following_calls(interaction_call_index)
            dispatched.extend(deferred_results)
            for emission in emissions:
                yield emission

        yield ToolRoundEmission("complete", SerialToolBatchOutcome(dispatched))

    def _defer_following_calls(
        self, call_index: int,
    ) -> tuple[list[ToolRoundEmission], list[tuple[Any, Any]]]:
        """交互挂起时，给未执行的同轮调用补齐明确回执，避免丢失调用配对。"""
        emissions: list[ToolRoundEmission] = []
        dispatched: list[tuple[Any, Any]] = []
        for index in range(call_index + 1, len(self.tool_calls)):
            tool_call = self.tool_calls[index]
            target, _arguments, _protocol_error = self.bindings.resolve_tool_call(
                getattr(tool_call, "name", None), getattr(tool_call, "input", None),
            )
            label = self.runner._label(target)
            if self.verify_mode:
                label = self.runner._label("_verify_prefix", "复查 · ") + label
            tool_call_id = getattr(tool_call, "id", None) or f"{self.round_id}-tool-{index + 1}"
            deferred = self.bindings.json_dumps({
                "status": "deferred",
                "reason": "同一轮的前置调用正在等待用户交互；恢复后可重新安排此调用。",
            }, ensure_ascii=False)
            dispatched.append((tool_call, deferred))
            emissions.append(ToolRoundEmission("event", {
                "type": "tool_call", "round_id": self.round_id,
                "tool_call_id": tool_call_id, "name": target, "label": label,
                "input": {}, "verify": self.verify_mode, "status": "deferred",
            }))
            emissions.append(ToolRoundEmission("event", {
                "type": "tool_done", "round_id": self.round_id,
                "tool_call_id": tool_call_id, "name": target, "label": label,
                "verify": self.verify_mode, "status": "deferred", "result": deferred,
            }))
        return emissions, dispatched
