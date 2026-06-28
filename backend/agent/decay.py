"""时间衰减（贬值）共用件：置信度/新鲜度随时间按半衰期衰减。

先给 summary（当前状态快照）用——越久没更新越不可信，注入时按权重加"可能过时"提示。
以后 lens（解读先验）的 confidence 衰减、World Model 其它元素都复用这套。
权重是**内部数**：调用方据它选离散话术，不把数字本身喂给 LLM。
"""
from __future__ import annotations

import time

# summary 半衰期（天）：5 天后权重 0.5、10 天 0.25。状态类信息几天就该打折。
SUMMARY_HALF_LIFE = 5.0


def age_days(updated_ts: float | None) -> float | None:
    """距上次更新多少天；无时间戳返回 None。"""
    if not updated_ts:
        return None
    return max(0.0, (time.time() - float(updated_ts)) / 86400.0)


def weight(updated_ts: float | None, half_life_days: float = SUMMARY_HALF_LIFE) -> float:
    """半衰期衰减权重 ∈ (0,1]。无时间戳 → 当新鲜（1.0，兼容旧数据；下次更新会补上 ts）。"""
    a = age_days(updated_ts)
    if a is None:
        return 1.0
    return 0.5 ** (a / max(0.1, half_life_days))
