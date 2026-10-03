"""单 Round 并行工具调度器（PRD-LLM-31）。"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

MAX_PARALLEL_TOOL_CALLS = 5


class ParallelDispatchCancelled(asyncio.CancelledError):
    """并行批次取消后携带已完成结果；未完成项以 CancelledError 占位。"""

    def __init__(self, results: list[Any]):
        super().__init__("并行工具批次已取消")
        self.results = results


async def run_parallel_dispatches(
    calls: Sequence[Any],
    dispatch: Callable[[Any], Awaitable[Any]],
    *,
    max_concurrency: int = MAX_PARALLEL_TOOL_CALLS,
) -> list[Any]:
    """每批最多并发 dispatch 指定数量，按输入顺序返回并隔离单项异常。"""
    if max_concurrency < 1:
        raise ValueError("max_concurrency 必须大于 0")
    if not calls:
        return []

    semaphore = asyncio.Semaphore(max_concurrency)
    results: list[Any] = []

    async def run_one(call: Any) -> Any:
        async with semaphore:
            try:
                return await dispatch(call)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                return exc

    for offset in range(0, len(calls), max_concurrency):
        batch = calls[offset:offset + max_concurrency]
        tasks = [asyncio.create_task(run_one(call)) for call in batch]
        try:
            results.extend(await asyncio.gather(*tasks))
        except asyncio.CancelledError as exc:
            for task in tasks:
                if not task.done():
                    task.cancel()
            settled = await asyncio.gather(*tasks, return_exceptions=True)
            cancelled = asyncio.CancelledError("工具调用已取消")
            settled.extend(cancelled for _ in range(len(calls) - len(results) - len(settled)))
            raise ParallelDispatchCancelled([*results, *settled]) from exc
    return results
