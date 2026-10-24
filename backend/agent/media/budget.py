"""按预计工作集限制媒体准备并发；取消等待者不会占用额度。"""
from contextlib import asynccontextmanager
import asyncio


class MediaMemoryBudget:
    def __init__(self, capacity: int = 128 * 1024 * 1024):
        self.capacity = capacity
        self.used = 0
        self._condition = asyncio.Condition()

    @asynccontextmanager
    async def reserve(self, size: int):
        # 大于预算的单项独占执行，不以预算值冒充 Provider 文件能力上限。
        weight = min(self.capacity, max(1, size))
        async with self._condition:
            await self._condition.wait_for(lambda: self.used + weight <= self.capacity)
            self.used += weight
        try:
            yield
        finally:
            async with self._condition:
                self.used -= weight
                self._condition.notify_all()


VIDEO_MEMORY_BUDGET = MediaMemoryBudget()
