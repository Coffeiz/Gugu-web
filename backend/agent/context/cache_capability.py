"""append_reuse 缓存命中观测（PRD-LLM-27 §6.7，2026-09-18 修订）。

实测结论（docs/reports/OPT-Cache-Strategy-LLM27-AB-*.md）：deepseek /
openai / anthropic / minimax / qwen 五个主流 provider 全部支持跨调用前缀
缓存，静态白名单失去存在意义，已废止。本模块保留纯观测职责：

- `record_reuse_outcome`：append_reuse 分支按 provider 返回的 cache_read
  记录命中/未命中（脱敏：只记 provider/model 指纹与计数，不涉正文）；
- `reuse_hit_rate`：查询近期命中率，供运行报告与成本分析。

注意：观测不再驱动任何资格判定——若未来某个 provider 实测不命中，处理
方式是回到本报告与 PRD 重新评估，而不是静默改变反思路径。
"""
from __future__ import annotations

import time
from collections import OrderedDict


def model_key(ai) -> str:
    """provider+model+api_format 的观测键。"""
    return f"{getattr(ai, 'provider', '')}:{getattr(ai, 'model', '')}:{getattr(ai, 'api_format', '')}"


_WINDOW_SECONDS = 3600.0
_MAX_KEYS = 64


class _HitRateLedger:
    """按 provider+model 记录近期命中窗口（纯观测，不驱动行为）。"""

    def __init__(self, *, window_seconds: float = _WINDOW_SECONDS, max_keys: int = _MAX_KEYS):
        self._window = float(window_seconds)
        self._max_keys = int(max_keys)
        # key -> OrderedDict[timestamp_monotonic, hit_bool]
        self._events: dict[str, OrderedDict] = {}

    def record(self, key: str, *, cache_hit: bool) -> None:
        now = time.monotonic()
        events = self._events.setdefault(key, OrderedDict())
        events[now] = bool(cache_hit)
        events.move_to_end(now)
        self._evict(events, now)
        while len(self._events) > self._max_keys:
            self._events.popitem(last=False)

    def _evict(self, events: OrderedDict, now: float) -> None:
        cutoff = now - self._window
        while events:
            oldest = next(iter(events))
            if oldest >= cutoff:
                break
            events.pop(oldest)

    def hit_rate(self, key: str) -> tuple[int, int]:
        """返回 (命中数, 总数)；窗口外事件已自然淘汰。"""
        events = self._events.get(key)
        if not events:
            return 0, 0
        now = time.monotonic()
        self._evict(events, now)
        total = len(events)
        hits = sum(1 for hit in events.values() if hit)
        return hits, total


_ledger = _HitRateLedger()


def record_reuse_outcome(ai, *, cache_hit: bool) -> None:
    """append_reuse 分支回填真实观测：provider 返回的 cache_read>0 记命中。"""
    _ledger.record(model_key(ai), cache_hit=cache_hit)


def reuse_hit_rate(ai) -> tuple[int, int]:
    """近期命中率 (命中数, 总数)，供报告与诊断；不影响任何资格判定。"""
    return _ledger.hit_rate(model_key(ai))
