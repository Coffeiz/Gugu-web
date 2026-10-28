"""Agent Loop 等待交互与恢复工具调用的生命周期协调。"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Awaitable, Callable

from agent.loop.models import PendingInteraction, RunState


@dataclass(frozen=True)
class InteractionBindings:
    """由主循环注入的兼容边界；交互状态机不反向读取 core 模块。"""

    classify_answer: Callable[[Any], str]
    replace_tool_result: Callable[..., bool]
    pending_tool_signal: Callable[..., dict[str, Any]]
    closing_frames: Callable[..., list[str]]
    dispatch_in_session: Callable[..., Awaitable[tuple[Any, Any]]]
    tool_result_payload: Callable[[Any], dict[str, Any]]
    is_successful_result: Callable[[Any], bool]
    is_cancelled: Callable[[], Awaitable[bool]]
    diag_log: Callable[[str, BaseException], None]


@dataclass(frozen=True)
class InteractionEmission:
    """交互过程产生的展示事件、原始终态帧、产物或流程动作。"""

    kind: str
    value: Any


@dataclass
class InteractionRuntime:
    """消费一个 pending interaction，并在确认后安全恢复同一工具调用。"""

    run_state: RunState
    messages: Any
    bindings: InteractionBindings
    user_id: Any
    session_id: int | None
    session: Any
    run_id: str
    round_id: str
    verify_mode: bool
    tool_snapshot: Any
    skill_state: dict[str, str]
    next_round: int
    cancel_close_text: str
    on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None

    async def resolve_pending(self) -> AsyncGenerator[InteractionEmission, None]:
        pending = self.run_state.pending
        if pending is None:
            raise RuntimeError("无法恢复不存在的待处理交互")

        from agent.llm import genstream
        from app.services.interactions import wait_for_resolution

        answer = await wait_for_resolution(
            user_id=self.user_id,
            prompt_id=pending.prompt_id,
            heartbeat=lambda: genstream.touch(self.session_id),
            cancel_check=self.bindings.is_cancelled,
        )
        answer_status = self.bindings.classify_answer(answer)
        if answer_status in {"user_cancelled", "aborted", "expired"}:
            async for emission in self._terminate_pending(pending, answer, answer_status):
                yield emission
            return

        replay = pending.replay
        if isinstance(answer, dict) and answer.get("status") == "confirmed" and isinstance(replay, dict):
            from agent.interactions.confirmations import is_block

            try:
                executed, artifact = await self.bindings.dispatch_in_session(
                    self.user_id,
                    replay["target"],
                    replay["input"],
                    session_id=self.session_id,
                    session=self.session,
                    run_id=self.run_id,
                    tool_snapshot=self.tool_snapshot,
                    skill_state=self.skill_state,
                    tool_call_id=pending.tool_call_id,
                )
            except Exception as exc:
                self.bindings.diag_log("agent.core.confirm_replay", exc)
                executed, artifact = {
                    "status": "error", "text": "确认后执行失败，请重新发起操作。",
                }, None
            if is_block(executed):
                executed, artifact = {
                    "status": "error", "text": "确认未生效，请重新发起操作。",
                }, None
            replay_payload = self.bindings.tool_result_payload(executed)

            if isinstance(replay_payload, dict) and replay_payload.get("_interaction") == "ask_user":
                from app.services.interactions import create_tool_interaction

                followup = await create_tool_interaction(
                    user_id=self.user_id,
                    session_id=self.session_id,
                    tool_call_id=pending.tool_call_id,
                    tool_name=replay["name"],
                    result=replay_payload,
                    kind="ask_user",
                )
                if followup is None:
                    self.bindings.diag_log(
                        "agent.core.confirm_replay_interaction",
                        RuntimeError("confirmed replay returned an invalid interaction"),
                    )
                    replay_payload = {
                        "status": "error",
                        "text": "确认后需要补充的信息无法建立，请重新发起操作。",
                    }
                else:
                    waiting_payload = json.dumps({
                        "status": "waiting_input", "prompt_id": followup["prompt_id"],
                    }, ensure_ascii=False)
                    self.bindings.replace_tool_result(
                        self.messages,
                        tool_call_id=pending.tool_call_id,
                        result=waiting_payload,
                    )
                    yield InteractionEmission("event", {
                        "type": "tool_done", "round_id": self.round_id,
                        "tool_call_id": pending.tool_call_id, "name": replay["name"],
                        "label": replay["label"], "verify": self.verify_mode,
                        "status": "waiting", "result": waiting_payload,
                    })
                    interaction_payload = {
                        **followup,
                        "round_id": self.round_id,
                        "tool_call_id": pending.tool_call_id,
                    }
                    yield InteractionEmission("event", {
                        "type": "interaction_required", **interaction_payload,
                    })
                    if self.on_interaction is not None:
                        await self.on_interaction(interaction_payload)

                    followup_answer = await wait_for_resolution(
                        user_id=self.user_id,
                        prompt_id=followup["prompt_id"],
                        heartbeat=lambda: genstream.touch(self.session_id),
                        cancel_check=self.bindings.is_cancelled,
                    )
                    followup_status = self.bindings.classify_answer(followup_answer)
                    if followup_status in {"user_cancelled", "aborted", "expired"}:
                        expired = followup_status == "expired"
                        yield InteractionEmission("event", {
                            "type": "tool_done", "round_id": self.round_id,
                            "tool_call_id": pending.tool_call_id, "name": replay["name"],
                            "label": replay["label"], "verify": self.verify_mode,
                            "status": "error" if expired else "cancelled",
                        })
                        if expired:
                            yield InteractionEmission("raw", self._raw_event({
                                "type": "error", "detail": "凭据输入已过期，请重新发起操作。",
                            }))
                        else:
                            yield InteractionEmission("raw", self._raw_event({"type": "_cancelled"}))
                        reason = "前一项确认已过期" if expired else "用户取消了前一项确认"
                        for emission in self._discard_queued_tool_interactions(reason):
                            yield emission
                        self.run_state.pending = None
                        yield InteractionEmission("action", "return")
                        return
                    self.bindings.replace_tool_result(
                        self.messages,
                        tool_call_id=pending.tool_call_id,
                        result=followup_answer,
                    )
                    # 用户可能提交密钥等敏感信息：终态只带状态，不回显答案。
                    yield InteractionEmission("event", {
                        "type": "tool_done", "round_id": self.round_id,
                        "tool_call_id": pending.tool_call_id, "name": replay["name"],
                        "label": replay["label"], "verify": self.verify_mode,
                        "status": (
                            "success" if self.bindings.is_successful_result(followup_answer)
                            else "error"
                        ),
                    })
                    self.run_state.pending = None
                    for emission in await self._activate_next_tool_interaction():
                        yield emission
                    yield InteractionEmission("event", {
                        "type": "_new_round", "round_id": self.round_id,
                        "next_round": self.next_round,
                    })
                    yield InteractionEmission("action", "continue")
                    return

            self.bindings.replace_tool_result(
                self.messages,
                tool_call_id=pending.tool_call_id,
                result=replay_payload,
            )
            yield InteractionEmission("event", {
                "type": "tool_done", "round_id": self.round_id,
                "tool_call_id": pending.tool_call_id, "name": replay["name"],
                "label": replay["label"], "verify": self.verify_mode,
                "status": (
                    "success" if self.bindings.is_successful_result(replay_payload) else "error"
                ),
                "result": replay_payload,
            })
            if artifact:
                yield InteractionEmission("artifact", artifact)
            self.run_state.pending = None
            for emission in await self._activate_next_tool_interaction():
                yield emission
            yield InteractionEmission("event", {
                "type": "_new_round", "round_id": self.round_id,
                "next_round": self.next_round,
            })
            yield InteractionEmission("action", "continue")
            return

        replaced = self.bindings.replace_tool_result(
            self.messages,
            tool_call_id=pending.tool_call_id,
            result=answer,
        )
        if not replaced:
            self.bindings.diag_log(
                "agent.core.interaction_resume",
                RuntimeError("pending tool result missing during interaction resume"),
            )
            yield InteractionEmission("raw", self._raw_event({
                "type": "error", "detail": "这次确认状态已失效，请重新发起操作。",
            }))
            self.run_state.pending = None
            for emission in self._discard_queued_tool_interactions("交互状态已失效"):
                yield emission
            yield InteractionEmission("action", "return")
            return

        # 用户答案可能包含敏感字段，只更新 canonical history，不放进展示事件。
        yield InteractionEmission("event", {
            "type": "tool_done", "round_id": self.round_id,
            "tool_call_id": pending.tool_call_id, "name": pending.tool_name,
            "status": "success", "verify": self.verify_mode,
        })
        self.run_state.pending = None
        for emission in await self._activate_next_tool_interaction():
            yield emission
        yield InteractionEmission("event", {
            "type": "_new_round", "round_id": self.round_id,
            "next_round": self.next_round,
        })
        yield InteractionEmission("action", "continue")

    async def _activate_next_tool_interaction(self) -> list[InteractionEmission]:
        """上一个交互完成后再创建下一项提示，避免同时挂出多个等待门。"""
        from agent.loop.models import PendingInteraction
        from app.services.interactions import create_tool_interaction

        emissions: list[InteractionEmission] = []
        while self.run_state.pending_tool_interactions:
            item = self.run_state.pending_tool_interactions.pop(0)
            interaction = await create_tool_interaction(
                user_id=self.user_id,
                session_id=self.session_id,
                tool_name=item["tool_name"],
                tool_call_id=item["tool_call_id"],
                result=item["result"],
                kind=item["kind"],
            )
            if interaction is None:
                result = json.dumps({
                    "error": (
                        "该工具需要用户交互，但系统未能创建交互请求；本次操作未继续。"
                        "请在有效的 Web 或 IM 对话中重新发起。"
                    ),
                    "interaction_unavailable": True,
                }, ensure_ascii=False)
                self.bindings.replace_tool_result(
                    self.messages, tool_call_id=item["tool_call_id"], result=result,
                )
                emissions.append(InteractionEmission("event", {
                    "type": "tool_done", "round_id": item["round_id"],
                    "tool_call_id": item["tool_call_id"], "name": item["tool_name"],
                    "label": item["label"], "verify": item["verify"],
                    "status": "error", "result": result,
                }))
                continue

            self.run_state.pending = PendingInteraction(
                interaction["prompt_id"], item["tool_call_id"], item["tool_name"],
                ({
                    "name": item["tool_name"], "label": item["label"],
                    "target": item["target"], "input": item["input"],
                } if item["kind"] == "confirmation" else None),
            )
            if item["kind"] == "ask_user":
                waiting_result = json.dumps({
                    "status": "waiting_input", "prompt_id": interaction["prompt_id"],
                }, ensure_ascii=False)
                self.bindings.replace_tool_result(
                    self.messages, tool_call_id=item["tool_call_id"], result=waiting_result,
                )
                emissions.append(InteractionEmission("event", {
                    "type": "tool_done", "round_id": item["round_id"],
                    "tool_call_id": item["tool_call_id"], "name": item["tool_name"],
                    "label": item["label"], "verify": item["verify"],
                    "status": "waiting", "result": waiting_result,
                }))
            payload = {
                **interaction,
                "round_id": item["round_id"],
                "tool_call_id": item["tool_call_id"],
            }
            emissions.append(InteractionEmission("event", {
                "type": "interaction_required", **payload,
            }))
            if self.on_interaction is not None:
                await self.on_interaction(payload)
            break
        return emissions

    def _discard_queued_tool_interactions(self, reason: str) -> list[InteractionEmission]:
        """结束尚未展示的确认，避免会话结束后留下永久 waiting 工具气泡。"""
        emissions: list[InteractionEmission] = []
        queued, self.run_state.pending_tool_interactions = self.run_state.pending_tool_interactions, []
        for item in queued:
            result = json.dumps({"status": "cancelled", "reason": reason}, ensure_ascii=False)
            self.bindings.replace_tool_result(
                self.messages, tool_call_id=item["tool_call_id"], result=result,
            )
            emissions.append(InteractionEmission("event", {
                "type": "tool_done", "round_id": item["round_id"],
                "tool_call_id": item["tool_call_id"], "name": item["tool_name"],
                "label": item["label"], "verify": item["verify"],
                "status": "cancelled", "result": result,
            }))
        return emissions

    async def _terminate_pending(
        self, pending: PendingInteraction, answer: Any, status: str,
    ) -> AsyncGenerator[InteractionEmission, None]:
        if status == "user_cancelled":
            self.bindings.replace_tool_result(
                self.messages, tool_call_id=pending.tool_call_id, result=answer,
            )
            yield InteractionEmission("event", self.bindings.pending_tool_signal(
                "cancelled", answer, pending, verify=self.verify_mode,
            ))
            reason = "用户取消了前一项确认"
        elif status == "aborted":
            yield InteractionEmission("event", self.bindings.pending_tool_signal(
                "cancelled", None, pending, verify=self.verify_mode,
            ))
            yield InteractionEmission("raw", self._raw_event({"type": "_cancelled"}))
            reason = "当前任务已取消"
        else:
            yield InteractionEmission("event", self.bindings.pending_tool_signal(
                "error", None, pending, verify=self.verify_mode,
            ))
            yield InteractionEmission("raw", self._raw_event({
                "type": "error", "detail": "这次交互已过期，请重新告诉我你的选择。",
            }))
            reason = "前一项确认已过期"
        for emission in self._discard_queued_tool_interactions(reason):
            yield emission
        if status == "user_cancelled":
            for frame in self.bindings.closing_frames(
                self.cancel_close_text, next_round=self.next_round,
            ):
                yield InteractionEmission("raw", frame)
        self.run_state.pending = None
        yield InteractionEmission("action", "return")

    @staticmethod
    def _raw_event(payload: dict[str, Any]) -> str:
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
