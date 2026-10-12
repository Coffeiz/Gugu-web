"""Agent Loop 单轮 Provider 请求的生命周期协调。"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, AsyncGenerator

_log = logging.getLogger("agent.core")


@dataclass(frozen=True)
class ProviderRoundEvent:
    """Provider 流中的一个输出事件；token 内容只交给调用方决定是否展示。"""

    kind: str
    value: Any


class ProviderRoundRuntime:
    """封装一次模型 round 的工具刷新、流关闭及 Responses 能力回退。"""

    def __init__(
        self,
        *,
        runner: Any,
        driver: Any,
        client: Any,
        context: Any,
        ai: Any,
        messages: Any,
        system_text: str | None,
        tool_snapshot: Any,
        tool_names: list[str],
        stream_round: Any,
        reasoning_state: Any = None,
        responses_fallback_used: bool = False,
    ) -> None:
        self.runner = runner
        self.driver = driver
        self.client = client
        self.context = context
        self.ai = ai
        self.messages = messages
        self.system_text = system_text
        self.tool_snapshot = tool_snapshot
        self.tool_names = list(tool_names)
        self.stream_round = stream_round
        self.reasoning_state = reasoning_state
        self.responses_fallback_used = responses_fallback_used

    def _refresh_tools(self) -> None:
        capability = self.runner.capability_context
        if (
            capability is None
            or getattr(capability, "fixed_adapter", False)
            or getattr(capability, "metadata_only", False)
        ):
            return
        selected = capability.select_for_messages(self.messages)
        self.tool_names = self.runner._provider_tool_names(list(selected.tool_names))
        self.driver.update_tools(
            self.context,
            self.tool_names,
            tool_snapshot=self.tool_snapshot,
        )

    async def stream(self) -> AsyncGenerator[ProviderRoundEvent, None]:
        """流出 token/retry/final 事件，并在 finally 中及时关闭底层生成器。"""
        self._refresh_tools()
        while True:
            round_gen = None
            token_count = 0
            result = None
            try:
                round_gen = self.driver.run_round(
                    self.client,
                    self.context,
                    self.messages,
                    stream_round=self.stream_round,
                )
                async for kind, value in round_gen:
                    if kind == "done":
                        result = value
                        break
                    if kind != "retry":
                        token_count += 1
                    yield ProviderRoundEvent(kind, value)
                await round_gen.aclose()
                round_gen = None
                break
            except Exception as exc:
                from agent.providers.openai_responses import ResponsesCompatibilityError

                if not (
                    isinstance(exc, ResponsesCompatibilityError)
                    and self.driver.api_format == "responses"
                    and token_count == 0
                    and result is None
                    and not self.responses_fallback_used
                ):
                    raise
                self.responses_fallback_used = True
                if self.reasoning_state is not None:
                    await self.reasoning_state.failed("responses_incompatible")
                from agent.loop_drivers import OpenAIDriver

                round_wrapper = getattr(self.driver, "_loopscope_round_wrapper", None)
                self.driver = OpenAIDriver()
                if callable(round_wrapper):
                    self.driver.run_round = round_wrapper(self.driver, self.driver.run_round)
                self.client, self.context = self.driver.prepare(
                    self.tool_names,
                    self.ai,
                    self.messages,
                    self.system_text,
                    tool_snapshot=self.tool_snapshot,
                )
                capability = self.runner.capability_context
                if capability is not None:
                    self.context.capability_context = capability
                _log.warning(
                    "Responses 完整请求不兼容，当前 run 回退 Chat Completions：status=%s",
                    exc.status_code,
                )
            finally:
                if round_gen is not None:
                    await round_gen.aclose()
        yield ProviderRoundEvent("done", result)
