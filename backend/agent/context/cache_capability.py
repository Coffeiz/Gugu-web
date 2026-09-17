"""provider 前缀缓存能力白名单（PRD-LLM-27 §6.7 第一关）。

追加式分支会把反思输入放大到整个主会话历史：对支持跨调用前缀缓存的
provider 这是净收益；对不支持的 provider（MiniMax/Qwen 实测不跨 HTTP 请求
持久化缓存），append_reuse 意味着按全新 input 计费整个历史，比独立反思
更贵。因此白名单是 eligible 判定的第一关：不在名单内一律 standalone，
即使输入逐字节一致也不走追加复用。

白名单只收录实测确认跨调用缓存生效的 provider；未知 provider 默认关闭
（保守侧），以真实 A/B 数据准入。运行中由 ReuseMissTracker 持续验证：
缓存率持续不达标的组合自动摘出（§6.7），防止「文档说支持、实际不命中」
的组合长期烧钱。
"""
from __future__ import annotations

import time

# 实测确认跨调用前缀缓存生效的 provider（deepseek 官方缓存口径；openai 自动
# 前缀缓存；anthropic ephemeral 断点跨请求生效）。qwen/minimax 明确不跨调用。
_DEFAULT_CAPABLE = frozenset({"deepseek", "openai", "anthropic"})

# 运行中摘出：窗口内连续 N 次命中率为 0 即摘出，冷却后重新给机会。
_MISS_THRESHOLD = 3
_MISS_COOLDOWN_SECONDS = 1800.0


def model_key(ai: Any) -> str:
    """provider+model+api_format 的判定键；同键共享白名单与摘出状态。"""
    return f"{getattr(ai, 'provider', '')}:{getattr(ai, 'model', '')}:{getattr(ai, 'api_format', '')}"


def prefix_cache_capable(ai: Any, settings=None) -> bool:
    """该模型组合是否允许走 append_reuse（第一关，与输入一致性无关）。"""
    provider = str(getattr(ai, "provider", "") or "")
    if not provider:
        return False
    if _miss_tracker.blocked(model_key(ai)):
        return False
    if provider not in _DEFAULT_CAPABLE:
        return False
    # anthropic 依赖主动缓存断点；该能力关闭时前缀没有断点可命中，
    # 跨调用复用无从谈起。
    if provider == "anthropic":
        from agent.llm.llm_select import supports_anthropic_active_cache
        if not supports_anthropic_active_cache(ai):
            return False
    return True


class ReuseMissTracker:
    """运行中摘出机制：记录 append_reuse 的实际缓存命中，连续零命中即摘出。

    Phase 1 只交付机制与测试；数据由 Phase 2 的分支执行链路喂入
    （provider 返回 cache_read=0 记 miss，>0 记 hit 并清零计数）。
    """

    def __init__(self, *, threshold: int = _MISS_THRESHOLD,
                 cooldown_seconds: float = _MISS_COOLDOWN_SECONDS) -> None:
        self._threshold = max(1, int(threshold))
        self._cooldown = float(cooldown_seconds)
        # key -> [consecutive_misses, blocked_until_monotonic]
        self._state: dict[str, list] = {}

    def record(self, ai: Any, *, cache_hit: bool) -> None:
        key = model_key(ai)
        entry = self._state.setdefault(key, [0, 0.0])
        if cache_hit:
            entry[0] = 0
            entry[1] = 0.0
            return
        if entry[1] > time.monotonic():
            return
        entry[0] += 1
        if entry[0] >= self._threshold:
            entry[1] = time.monotonic() + self._cooldown
            entry[0] = 0

    def blocked(self, key: str) -> bool:
        entry = self._state.get(key)
        if not entry:
            return False
        if entry[1] > time.monotonic():
            return True
        if entry[1] > 0.0:
            # 冷却结束：恢复候选资格，重新累计观测。只清理「曾有封锁」的条目，
            # 未封锁状态的连击计数不能被查询副作用清零。
            entry[0] = 0
            entry[1] = 0.0
        return False


_miss_tracker = ReuseMissTracker()


def record_reuse_outcome(ai: Any, *, cache_hit: bool) -> None:
    """喂真实观测（Phase 2 接入）：append_reuse 分支按 provider 返回的
    cache_read 记 hit/miss，驱动运行中自动摘出（§6.7）。"""
    _miss_tracker.record(ai, cache_hit=cache_hit)

