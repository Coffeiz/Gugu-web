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
