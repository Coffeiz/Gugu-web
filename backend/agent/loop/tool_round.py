"""Agent Loop 工具轮次执行片段。"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, AsyncGenerator

from agent.interactions.confirmations import confirmation_payload
from agent.loop.events import artifact_sse

_log = logging.getLogger("agent.traj")


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
                "label": label, "input": dispatch_input,
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
                    "input": meta[3], "verify": self.verify_mode, "status": "running",
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

        succeeded = failed = cancelled = 0
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
                if (
                    confirmation_payload(result_payload) is not None
                    or not self.bindings.is_successful_result(result_payload)
                ):
                    failed += 1
                else:
                    succeeded += 1
                results_by_index[original_index] = dispatched_result

        self.bindings.log_batch({
            "mode": "parallel",
            "calls": len(self.parallel_batch),
            "isolated_invalid": len(self.protocol_errors),
            "reason": "eligible_batch",
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
            result, artifact = results_by_index[original_index]
            call_cancelled = isinstance(result, asyncio.CancelledError)
            if call_cancelled:
                result = json.dumps({"error": "工具调用已取消。"}, ensure_ascii=False)
                artifact = None
            if isinstance(result, Exception):
                self.bindings.diag_log("agent.loop.parallel_tool_dispatch", result)
                result = json.dumps({"error": "只读工具执行失败，请稍后重试。"}, ensure_ascii=False)
                artifact = None
            if confirmation_payload(result) is not None:
                self.bindings.diag_log(
                    "agent.loop.parallel_tool_interaction",
                    RuntimeError("并发安全工具返回了交互确认载荷"),
                )
                result = json.dumps(
                    {"error": "该只读工具返回了未声明的确认请求，本次结果无法使用。"},
                    ensure_ascii=False,
                )
                artifact = None
            yield ToolRoundEmission("event", {
                "type": "tool_done", "round_id": self.round_id,
                "tool_call_id": tool_call_id, "name": effective_name,
                "label": label, "verify": self.verify_mode,
                "status": (
                    "cancelled" if call_cancelled else
                    "success" if self.bindings.is_successful_result(result) else "error"
                ),
                "result": result,
            })
            if artifact:
                yield ToolRoundEmission("artifact", artifact)
            dispatched.append((call, result))

        yield ToolRoundEmission(
            "complete",
            ParallelToolBatchOutcome(dispatched=dispatched, cancelled=parallel_cancelled),
        )


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

            if effective_name in {"ask_user", "manage_mcp_servers"}:
                try:
                    ask_payload = self.bindings.json_loads(result) if isinstance(result, str) else result
                except (TypeError, ValueError):
                    ask_payload = None
                from app.services.interactions import create_agent_prompt

                interaction = None
                if isinstance(ask_payload, dict) and ask_payload.get("_interaction") == "ask_user":
                    interaction = await create_agent_prompt(
                        user_id=self.user_id, session_id=self.session_id,
                        tool_call_id=tool_call_id, tool_name=effective_name,
                        payload=ask_payload,
                    )
                if interaction is not None:
                    prompt, actions = interaction
                    schema = prompt.schema_json or {}
                    secret_fields = list(schema.get("secret_fields") or [])
                    pending_result = self.bindings.json_dumps({
                        "status": "waiting_input", "prompt_id": prompt.id,
                    }, ensure_ascii=False)
                    dispatched.append((tool_call, pending_result))
                    self.run_state.pending = self.bindings.pending_interaction_type(
                        prompt.id, tool_call_id, effective_name,
                    )
                    yield emit(
                        "tool_done", round_id=self.round_id, tool_call_id=tool_call_id,
                        name=effective_name, label=label, verify=self.verify_mode,
                        status="waiting", result=pending_result,
                    )
                    interaction_payload = {
                        "prompt_id": prompt.id, "kind": prompt.kind,
                        "title": prompt.title, "body": prompt.body,
                        "options": actions,
                        "allow_text_input": bool(schema.get("allow_text_input", False)),
                        "secret_fields": secret_fields,
                        "expires_at": prompt.expires_at.isoformat(),
                        "round_id": self.round_id, "tool_call_id": tool_call_id,
                    }
                    yield emit("interaction_required", **interaction_payload)
                    if self.on_interaction is not None:
                        await self.on_interaction(interaction_payload)
                    break

            from app.services.interactions import create_tool_confirmation

            interaction = await create_tool_confirmation(
                user_id=self.user_id, session_id=self.session_id,
                tool_name=effective_name, tool_call_id=tool_call_id, result=result,
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
                break

            dispatched.append((tool_call, result))
            yield emit(
                "tool_done", round_id=self.round_id, tool_call_id=tool_call_id,
                name=effective_name, label=label, verify=self.verify_mode,
                status="success" if self.bindings.is_successful_result(result) else "error",
                result=result,
            )
            if artifact:
                yield ToolRoundEmission("artifact", artifact)

        yield ToolRoundEmission("complete", SerialToolBatchOutcome(dispatched))
