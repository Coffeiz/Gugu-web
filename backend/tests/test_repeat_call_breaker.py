"""连续相同调用熔断的粒度回归：按「轮」计数，不拦单轮内多个相同调用。

2026-09-18 定稿：模型在一轮里并行发多个相同观察类调用（如 3 个相同
web_search）是合法形态；熔断针对的是「跨轮反复重要同一结果」的卡死形态。
"""
from __future__ import annotations

from types import SimpleNamespace

from agent.loop.tools import RepeatCallBreaker


def _snap(repeat_safe: bool = True):
    return {"web_search": SimpleNamespace(repeat_safe=repeat_safe)}


def test_same_round_multiple_identical_calls_count_once():
    breaker = RepeatCallBreaker(limit=3)
    breaker.begin_round()
    for _ in range(5):   # 单轮 5 个完全相同的调用：全部放行
        assert breaker.register(_snap(), "web_search", {"q": "塔斯汀"}) is False
    assert breaker.count == 1


def test_cross_round_repetition_accumulates_and_blocks_on_fourth_round():
    breaker = RepeatCallBreaker(limit=3)
    for round_index in range(1, 5):
        breaker.begin_round()
        blocked = breaker.register(_snap(), "web_search", {"q": "同一查询"})
        if round_index <= 3:
            assert blocked is False
        else:
            assert blocked is True   # 第 4 个连续相同轮被拦
    assert breaker.count == 4


def test_new_args_resets_count():
    breaker = RepeatCallBreaker(limit=3)
    for _ in range(3):
        breaker.begin_round()
        breaker.register(_snap(), "web_search", {"q": "a"})
    breaker.begin_round()
    assert breaker.register(_snap(), "web_search", {"q": "换个词"}) is False
    assert breaker.count == 1


def test_non_repeat_safe_call_resets_consecutive_chain():
    breaker = RepeatCallBreaker(limit=3)
    for _ in range(3):
        breaker.begin_round()
        breaker.register(_snap(), "web_search", {"q": "a"})
    breaker.begin_round()
    assert breaker.register(_snap(), "ask_user", {"q": "?"}) is False   # 非白名单打断连续
    breaker.begin_round()
    assert breaker.register(_snap(), "web_search", {"q": "a"}) is False
    assert breaker.count == 1


def test_multiple_identical_plus_one_different_in_same_round():
    """同轮「3 相同 + 1 不同」：相同组记 1 次，不同调用重置链，下一轮从 1 起算。"""
    breaker = RepeatCallBreaker(limit=3)
    breaker.begin_round()
    for _ in range(3):
        assert breaker.register(_snap(), "web_search", {"q": "x"}) is False
    assert breaker.register(_snap(), "list_dir", {"p": "/"}) is False   # 非 repeat_safe → 重置
    breaker.begin_round()
    assert breaker.register(_snap(), "web_search", {"q": "x"}) is False
    assert breaker.count == 1
