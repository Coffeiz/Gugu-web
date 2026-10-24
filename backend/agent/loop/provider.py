"""Provider round 调用、瞬时错误重试与 usage 归一化（PRD-LLM-25 LLM25-003）。

这里是 provider 流式调用的唯一实现；`agent/core.py` 保留 `_stream_round` /
`_provider_context_usage` 兼容别名（旧测试经 core 符号 monkeypatch），
`loop_drivers.AnthropicDriver.run_round` 通过显式注入的 ``stream_round``
参数拿到实现——不再反向 import `core.py`。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from agent.providers.errors import anthropic_stream_protocol_details
from app.core.errors import RetryableError
from app.core.redaction import diag_log
from app.core.retry import LLM_RETRY

_log = logging.getLogger("agent.core.loop.provider")


async def _non_streaming_round(client, kwargs, *, provider: str, cause: BaseException):
    """只重新请求当前模型轮次；把恢复正文交回正常输出链，不执行任何工具。"""
    protocol = anthropic_stream_protocol_details(cause)
    diag_log(f"agent.core.stream_round provider={provider} fallback=non_streaming protocol={protocol}", cause)
    _log.warning("模型流式响应解析失败，使用非流式请求恢复当前轮次")
    try:
        message = await client.messages.create(**kwargs)
    except Exception as recovery_error:
        diag_log(f"agent.core.stream_round provider={provider} recovery_failed", recovery_error)
        raise
    for block in message.content:
        if block.type == "text" and block.text:
            yield ("token", block.text)
    yield ("final", message)


def _recoverable_stream_error(error, adapter, transient) -> bool:
    """MiniMax 仅恢复已确认的坏块索引；其余 provider 保持既有解析降级规则。"""
    if isinstance(error, IndexError) and getattr(adapter, "name", "") == "minimax":
        return anthropic_stream_protocol_details(error) is not None
    return isinstance(error, (IndexError, KeyError)) and not isinstance(error, transient)


# ⑦ 慢尾兜底：LLM 瞬时错误（限流 429 / 超时 / 网络 / 5xx / 过载 529）统一按
# app/core/retry.py 的主对话节奏重试——固定 5s 间隔、最多 5 次。
# 只在「本轮还没吐 token 前」重试（已吐过再重试会重复输出）。
# OverloadedError（529）是 APIStatusError 的直接子类、不是 InternalServerError
# 的子类（2026-09-18 MiniMax 高峰 529 连穿排查确认），必须显式列出。


async def stream_round(client, kwargs, adapter=None):
    """跑一轮 Anthropic 流式，遇瞬时错误在出 token 前退避重试（P2-b §4-A 标杆模板）。
    yield ('token', delta) 逐字；结束 yield ('final', message)。

    两种「抛出」语义不同，调用方（主循环边界）据此区分：
    - **已吐过 token 中途出错**：不能重试（会重复输出），原样把底层异常抛出去——这不是
      「重试用尽」，是「已产生副作用不敢重试」，按未知/中断处理，不伪装成 RetryableError。
    - **重试用尽、一个 token 都没吐过**：包成 `RetryableError`（真正符合可重试语义：
      幂等——还没输出任何东西，从头重试不会重复）。

    `adapter`（`agent.providers.ProviderAdapter`）可选——不传（`None`）时只用下面这几个
    provider 无关的基础瞬时错误类型；传了就叠加该 provider 专属的容错（PRD-LLM-1）。
    MiniMax 已确认的内容块缺失不再反复请求坏流：未输出正文时仅以相同参数恢复一次非流式请求。
    """
    import anthropic
    transient = (anthropic.RateLimitError, anthropic.APITimeoutError,
                 anthropic.APIConnectionError, anthropic.InternalServerError,
                 anthropic.OverloadedError, httpx.TimeoutException,
                 httpx.NetworkError, httpx.RemoteProtocolError)
    if adapter is not None:
        # 各 provider 专属的「流式响应跟 SDK 期望 schema 对不上」容错，只加给对应 provider——
        # 见 agent/providers.py 里每个适配器 transient_exceptions 的注释（MiniMax 的
        # IndexError/KeyError/AttributeError 是目前唯一非空的一份）。不全局放宽，避免把
        # 跟该 provider 无关的真实 bug 也当"重试就好"吞掉。
        transient = transient + adapter.transient_exceptions

    def _error_kind(exc: BaseException) -> str:
        """脱敏类别标签：随 retry 事件给前端状态行显示，不带上游正文。"""
        if adapter is not None and getattr(adapter, "name", "") == "minimax":
            from agent.providers.minimax import minimax_error_details

            details = minimax_error_details(exc)
            if details is not None:
                if details.code == "1001":
                    return "timeout"
                if details.code == "1002":
                    return "rate_limited"
                if details.code in {"1000", "1024", "1033"}:
                    return "server_error"
        if isinstance(exc, anthropic.RateLimitError):
            return "rate_limited"
        if isinstance(exc, anthropic.OverloadedError):
            return "overloaded"
        if isinstance(exc, (anthropic.APITimeoutError, httpx.TimeoutException)):
            return "timeout"
        if isinstance(exc, (anthropic.APIConnectionError, httpx.NetworkError,
                            httpx.RemoteProtocolError)):
            return "network"
        if isinstance(exc, anthropic.InternalServerError):
            return "server_error"
        return type(exc).__name__.lower()

    started_at = time.monotonic()
    retries_done = 0
    while True:
        emitted = False
        try:
            async with client.messages.stream(**kwargs) as stream:
                async for delta in stream.text_stream:
                    emitted = emitted or bool(delta)
                    yield ("token", delta)
                yield ("final", await stream.get_final_message())
                return
        except Exception as e:
            if emitted:
                raise   # 已吐 token，重试会重复输出——原样抛给上层当未知/中断处理
            if _recoverable_stream_error(e, adapter, transient):
                provider = adapter.name if adapter is not None else "unknown"
                try:
                    async for event in _non_streaming_round(client, kwargs, provider=provider, cause=e):
                        yield event
                except transient as recovery_error:
                    raise RetryableError(
                        "llm.stream_parse_fallback_failed", "LLM 流式解析失败且降级重发未成功",
                        cause=recovery_error, attempt=retries_done,
                    ) from recovery_error
                return
            minimax_retryable = False
            if adapter is not None and getattr(adapter, "name", "") == "minimax":
                from agent.providers.minimax import is_retryable_error

                minimax_retryable = is_retryable_error(e)
            if not isinstance(e, transient) and not minimax_retryable:
                raise
            if not LLM_RETRY.should_retry(retries_done, started_at):
                # where 里带上 provider——上次这里崩溃排查时 diag_log 没记 provider，只能靠
                # 静态代码分析猜是哪家（PRD-LLM-1「待确认问题」），这次直接把它写进日志，
                # 下次同类问题不用再猜。
                _provider = adapter.name if adapter is not None else "unknown"
                diag_log(f"agent.core.stream_round provider={_provider}", e)   # 原始 → 受限诊断出口
                _log.warning("LLM 流式调用重试 %d 次后仍失败：%s", retries_done, type(e).__name__)
                raise RetryableError("llm.stream_exhausted", "LLM 调用重试后仍失败",
                                      cause=e, attempt=retries_done) from e
            retries_done += 1
            # 重试对用户可见：UI 状态行就地显示「过载，Ns 后自动重试（n/max）」，不插消息气泡
            yield ("retry", {
                "attempt": retries_done,
                "max_retries": LLM_RETRY.max_retries,
                "next_retry_in": LLM_RETRY.interval_seconds,
                "error_kind": _error_kind(e),
            })
            _log.info("LLM 瞬时错误 %s，%ss 后重试(%d)",
                      type(e).__name__, LLM_RETRY.interval_seconds, retries_done)
            await LLM_RETRY.pause()


def provider_context_usage(driver: Any, result: Any) -> int:
    """返回用于上下文阈值判断的完整 provider 输入量。

    driver 层已把两条路归一成统一语义：``usage_in`` 只含未命中缓存的输入，
    缓存命中在 ``cache_tokens``，Anthropic 本轮新写入缓存在
    ``cache_write_tokens``。真实上下文占用 = 三者之和，不能只取 usage_in——
    高缓存率下（如 DeepSeek 长对话 90%+ 命中）会把 100k 上下文看成 20k，
    严重延迟 90% 压缩阈值甚至撞 context limit。
    """
    return (max(0, int(getattr(result, "usage_in", 0) or 0))
            + max(0, int(getattr(result, "cache_tokens", 0) or 0))
            + max(0, int(getattr(result, "cache_write_tokens", 0) or 0)))


# ── 驱动侧 stream_round 解析槽（依赖倒转）─────────────────────────────────────
# loop_drivers 不得反向 import core（LLM25-003 验收）；但旧测试通过
# `monkeypatch.setattr(core, "_stream_round", fake)` 替换实现，且部分测试直调
# driver.run_round。core 启动时把 resolver 注册进来（读 core 模块全局，保证
# patch 生效）；未注册时回退到本模块的正统实现。
_driver_stream_round_resolver = None


def set_driver_stream_round_resolver(resolver) -> None:
    """注册驱动侧 stream_round 解析器（由 agent.core 在导入时调用）。"""
    global _driver_stream_round_resolver
    _driver_stream_round_resolver = resolver


def resolve_driver_stream_round():
    if _driver_stream_round_resolver is not None:
        return _driver_stream_round_resolver()
    return stream_round
