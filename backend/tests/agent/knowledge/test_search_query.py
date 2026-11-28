import pytest
from sqlalchemy import column

from app.search.query import normalize_mode, normalize_queries, keyword_condition


def test_normalize_queries_keeps_legacy_phrase_and_deduplicates_array():
    assert normalize_queries("项目 部署") == ["项目 部署"]
    assert normalize_queries(queries=[" 项目 ", "部署", "项目", ""]) == ["项目", "部署"]


def test_normalize_queries_limits_count_and_length():
    values = ["x" * 100] + [str(i) for i in range(20)]
    result = normalize_queries(queries=values)
    assert len(result) == 8
    assert len(result[0]) == 64


@pytest.mark.parametrize(("values", "expected"), [
    (["Straße", "STRASSE"], ["Straße"]),
    (["Σ", "ς", "σ"], ["Σ"]),
    (["ﬃ", "ffi"], ["ﬃ"]),
    (["Ꭰ", "ꭰ"], ["Ꭰ"]),
    (["İ", "i\u0307", "i", "ı", "Ａ", "a"], ["İ", "i", "ı", "Ａ", "a"]),
    (["\u001c目标\u0085", "目标", "\ufeff目标\ufeff"], ["目标", "\ufeff目标\ufeff"]),
    (["a" * 63 + "ß", "a" * 63 + "ss"], ["a" * 63 + "ß", "a" * 63 + "s"]),
])
def test_normalize_queries_preserves_python_unicode_and_operation_order(values, expected):
    """保护跨语言迁移中的完整折叠、空白差异及先截断再去重顺序。"""
    assert normalize_queries(queries=values) == expected


def test_normalize_mode_defaults_invalid_values_to_or():
    assert normalize_mode(None) == "OR"
    assert normalize_mode("and") == "AND"
    assert normalize_mode("xor") == "OR"


def test_keyword_condition_builds_or_or_and_groups():
    name = column("name")
    client = column("client")
    or_sql = str(keyword_condition([name, client], ["项目", "部署"], "OR")).lower()
    and_sql = str(keyword_condition([name, client], ["项目", "部署"], "AND")).lower()
    assert " or " in or_sql
    assert " and " in and_sql
