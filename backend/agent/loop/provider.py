"""Provider round 调用、瞬时错误重试与 usage 归一化（PRD-LLM-25 LLM25-003）。

这里是 provider 流式调用的唯一实现；`agent/core.py` 保留 `_stream_round` /
`_provider_context_usage` 兼容别名（旧测试经 core 符号 monkeypatch），
`loop_drivers.AnthropicDriver.run_round` 通过显式注入的 ``stream_round``
参数拿到实现——不再反向 import `core.py`。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.core.errors import RetryableError
from app.core.redaction import diag_log

_log = logging.getLogger("agent.core.loop.provider")

# ⑦ 慢尾兜底：LLM 瞬时错误（限流 429 / 超时 / 网络 / 5xx）退避重试——贴着并发上限跑时
# 把偶发 429 吸收成短延迟、不丢消息。只在「本轮还没吐 token 前」重试（已吐过再重试会重复输出）。
RETRY_BACKOFF = [1, 2, 4]   # 退避秒数；最多重试 3 次


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
    """
    import anthropic
    transient = (anthropic.RateLimitError, anthropic.APITimeoutError,
                 anthropic.APIConnectionError, anthropic.InternalServerError)
    if adapter is not None:
        # 各 provider 专属的「流式响应跟 SDK 期望 schema 对不上」容错，只加给对应 provider——
        # 见 agent/providers.py 里每个适配器 transient_exceptions 的注释（MiniMax 的
        # IndexError/KeyError/AttributeError 是目前唯一非空的一份）。不全局放宽，避免把
        # 跟该 provider 无关的真实 bug 也当"重试就好"吞掉。
        transient = transient + adapter.transient_exceptions
    last = None
    for i in range(len(RETRY_BACKOFF) + 1):
        emitted = False
        try:
            async with client.messages.stream(**kwargs) as stream:
                async for delta in stream.text_stream:
                    emitted = True
                    yield ("token", delta)
                yield ("final", await stream.get_final_message())
                return
        except transient as e:
            last = e
            if emitted:
                raise   # 已吐 token，重试会重复输出——原样抛给上层当未知/中断处理
            if i >= len(RETRY_BACKOFF):
                # where 里带上 provider——上次这里崩溃排查时 diag_log 没记 provider，只能靠
                # 静态代码分析猜是哪家（PRD-LLM-1「待确认问题」），这次直接把它写进日志，
                # 下次同类问题不用再猜。
                _provider = adapter.name if adapter is not None else "unknown"
                diag_log(f"agent.core.stream_round provider={_provider}", e)   # 原始 → 受限诊断出口
                _log.warning("LLM 流式调用重试 %d 次后仍失败：%s", i, type(e).__name__)
                raise RetryableError("llm.stream_exhausted", "LLM 调用重试后仍失败",
                                      cause=e, attempt=i) from e
            _log.info("LLM 瞬时错误 %s，%ss 后重试(%d)", type(e).__name__, RETRY_BACKOFF[i], i + 1)
            await asyncio.sleep(RETRY_BACKOFF[i])
    if last:
        raise last


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
