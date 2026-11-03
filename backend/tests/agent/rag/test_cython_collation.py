"""保护 TS RAG 的 en-US 字符串并列排序契约。"""
from __future__ import annotations

from agent.rag.cython_collation import locale_sort_key, reverse_locale_sort_key


def test_rag_tie_keys_follow_ts_en_us_locale_compare_order() -> None:
    """RAG tie-break 对大小写、重音和标点遵循固定 en-US collation。"""
    values = ["aA", "aa", "a_b", "a-b", "ä", "A", "-"]

    assert sorted(values, key=locale_sort_key) == ["-", "A", "ä", "a_b", "a-b", "aa", "aA"]


def test_reverse_rag_tie_key_reverses_prefix_order() -> None:
    """降序 localeCompare 必须连同字符串前缀关系一起反向。"""
    values = ["2026-10", "2026-10-01", "2026-09"]

    assert sorted(values, key=reverse_locale_sort_key) == ["2026-10-01", "2026-10", "2026-09"]
