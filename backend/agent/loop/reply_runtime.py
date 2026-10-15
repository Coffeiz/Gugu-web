"""Agent Loop 回复守卫的跨轮次状态与重试决策。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


MAX_EMPTY_REPLY_RETRIES = 2


@dataclass(frozen=True)
class ReplyDecisionBindings:
    """注入主循环的语言策略，避免重复实现既有守卫规则。"""

    looks_like_narration: Callable[[str, str | None], bool]
    announces_intent: Callable[[str, str | None], bool]
    ends_with_colon: Callable[[str], bool]
    is_tool_progress_only: Callable[[str, str | None], bool]
    is_decision_dodge: Callable[[str, str, str | None], bool]
    guard_locale: Callable[[str | None], Any]


@dataclass
class ReplyState:
    """跨 provider round 的回复策略状态。"""

    empty_retry: int = 0
    any_tool_called: bool = False
    narration_retry: int = 0
    decision_retry: int = 0
    intent_retry: int = 0
    colon_retry: int = 0
    tool_intent_retry: int = 0
    guard_retry_pending: bool = False
    colon_retry_pending: bool = False
    guard_retry_buf: list[str] = field(default_factory=list)

    def tool_round_started(self) -> None:
        self.any_tool_called = True
        if self.guard_retry_pending:
            self.guard_retry_pending = False
            self.colon_retry_pending = False
            self.guard_retry_buf.clear()

    def tool_round_succeeded(self) -> None:
        """成功工具带来实际进展后，允许最终答复阶段重新获得空回复重试机会。"""
        self.empty_retry = 0


@dataclass(frozen=True)
class ReplyDecision:
    """回复轮决策；副作用（追加提示、流式输出、结束 run）由 runner 执行。"""

    action: str
    retry_kind: str | None = None
    prompt: str | None = None
    visible_text: str | None = None


@dataclass
class ReplyRuntime:
    state: ReplyState
    bindings: ReplyDecisionBindings

    def decide(
        self,
        *,
        final_text: str,
        result: Any,
        round_tool_called: bool,
        verify_mode: bool,
        requires_tools: bool,
        user_request: str,
        locale: str | None,
        decision_guard_enabled: bool,
    ) -> ReplyDecision:
        """按既有优先顺序判断空回复、行动意图和不完整输出重试。"""
        state = self.state
        policy = self.bindings

        if state.guard_retry_pending:
            visible_text = None
            if (
                state.colon_retry_pending
                and final_text.strip()
                and not policy.ends_with_colon(final_text)
                and not policy.looks_like_narration(final_text, locale)
                and not policy.announces_intent(final_text, locale)
                and not policy.is_tool_progress_only(final_text, locale)
                and requires_tools is not True
            ):
                visible_text = final_text
            state.guard_retry_pending = False
            state.colon_retry_pending = False
            state.guard_retry_buf.clear()
            return ReplyDecision("complete_after_guard", visible_text=visible_text)

        if not final_text.strip() and not verify_mode:
            if state.empty_retry < MAX_EMPTY_REPLY_RETRIES:
                state.empty_retry += 1
                return ReplyDecision("retry", retry_kind="empty")
            return ReplyDecision(
                "continue_checks",
                visible_text="嗯…我这下没太接住，你再说一遍、或者换个说法，我马上跟上～",
            )

        if (
            not state.any_tool_called
            and not verify_mode
            and state.narration_retry < 1
            and policy.looks_like_narration(final_text, locale)
        ):
            state.narration_retry += 1
            return self._guard_retry(policy.guard_locale(locale).narration_nudge)

        if (
            not round_tool_called
            and not verify_mode
            and state.intent_retry < 1
            and policy.announces_intent(final_text, locale)
        ):
            state.intent_retry += 1
            return self._guard_retry(policy.guard_locale(locale).intent_nudge)

        if (
            not round_tool_called
            and not verify_mode
            and state.colon_retry < 1
            and policy.ends_with_colon(final_text)
        ):
            state.colon_retry += 1
            state.colon_retry_pending = True
            return self._guard_retry(policy.guard_locale(locale).colon_nudge)

        if (
            not state.any_tool_called
            and not verify_mode
            and state.tool_intent_retry < 1
            and (requires_tools is True or policy.is_tool_progress_only(final_text, locale))
        ):
            state.tool_intent_retry += 1
            return self._guard_retry(policy.guard_locale(locale).tool_required_nudge)

        if (
            decision_guard_enabled
            and not state.any_tool_called
            and not verify_mode
            and state.decision_retry < 1
            and policy.is_decision_dodge(user_request, final_text, locale)
        ):
            state.decision_retry += 1
            return self._guard_retry(policy.guard_locale(locale).decision_nudge)

        return ReplyDecision("complete")

    def _guard_retry(self, prompt: str) -> ReplyDecision:
        self.state.guard_retry_pending = True
        self.state.guard_retry_buf.clear()
        return ReplyDecision("retry", retry_kind="guard", prompt=prompt)
