"""统一的 LLM provider 调用重试策略（全站唯一出处，2026-09-18 定稿）。

节奏：固定 5s 间隔、最多 5 次重试、总墙钟 90s 先到为准。固定间隔取代旧的
1/2/4s 指数退避——过载窗口里 1s 的首次重试几乎必败，等于浪费配额；5s 起
步直接对准「秒级尖峰」的恢复节奏。墙钟上限兜住超时类错误（每次尝试本身
要烧满读超时，纯次数上限会拖到分钟级才报错）。

分支约定：
- `LLM_RETRY`：主对话流式调用（stream_round）。
- `BRANCH_RETRY`：压缩等阻塞分支——run 停在那等结果，且已有本地有界摘要
  等兜底，次数收少（共 2 次尝试），快速落兜底比硬等更划算。

配套约束（改这两处时必须同步看）：
- SDK 内建重试必须收零（build_anthropic_client / build_openai_client 传
  ``max_retries=0``）——否则应用层每次尝试内部还会偷偷打 3 发立即请求，
  5×3=15 发，退避节奏就不再由本模块控制。
- 重试只在「吐出首个 token 之前」进行（已吐过再重试会重复输出），这条
  语义在调用方（stream_round 的 emitted 守卫），不属于本模块。
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

RETRY_INTERVAL_SECONDS = 5.0
RETRY_MAX_RETRIES = 5
RETRY_MAX_WALL_SECONDS = 90.0
BRANCH_MAX_RETRIES = 1   # 压缩分支：1 次重试（共 2 次尝试）后快速落本地兜底


@dataclass(frozen=True)
class RetryPolicy:
    """不可变策略对象：should_retry + pause 两件套，调用方自己写循环。"""

    max_retries: int = RETRY_MAX_RETRIES
    interval_seconds: float = RETRY_INTERVAL_SECONDS
    max_wall_seconds: float = RETRY_MAX_WALL_SECONDS

    def should_retry(self, retries_done: int, started_at: float) -> bool:
        """重试次数与总墙钟先到为准（起点 = 本轮调用循环开始时刻）。"""
        if retries_done >= self.max_retries:
            return False
        return (time.monotonic() - started_at) < self.max_wall_seconds

    async def pause(self) -> None:
        await asyncio.sleep(self.interval_seconds)


LLM_RETRY = RetryPolicy()
BRANCH_RETRY = RetryPolicy(max_retries=BRANCH_MAX_RETRIES)
