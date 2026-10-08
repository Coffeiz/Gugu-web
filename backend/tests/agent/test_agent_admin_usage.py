from datetime import datetime, timezone

from app.api.v1.agent_admin import (
    _CACHE_USAGE_CUTOFF_SQL,
    _effective_input_sql,
    _effective_input_tokens,
    _utc_aware,
    _usage_local_hour,
    _usage_filters,
    _usage_timezone_expr,
)


def test_effective_input_tokens_preserves_historical_openai_and_new_full_input():
    assert _effective_input_tokens("anthropic", 100, 700, 20) == 820
    assert _effective_input_tokens("minimax", 100, 700, 20) == 820
    assert _effective_input_tokens(
        "deepseek", 800, 700, 20,
        datetime(2026, 9, 2, tzinfo=timezone.utc),
    ) == 800
    assert _effective_input_tokens(
        "deepseek", 800, 700, 20,
        datetime(2026, 9, 4, tzinfo=timezone.utc),
    ) == 1520


def test_effective_input_sql_uses_the_same_full_input_contract():
    assert _effective_input_sql() == (
        "CASE WHEN LOWER(provider) IN ('anthropic', 'minimax') "
        f"OR created_at >= {_CACHE_USAGE_CUTOFF_SQL} "
        "THEN tokens_in + cache_read + cache_write ELSE tokens_in END"
    )


def test_usage_timezone_is_validated_before_sql_is_built():
    tz, expr = _usage_timezone_expr("Asia/Shanghai")
    assert getattr(tz, "key") == "Asia/Shanghai"
    assert expr == "'Asia/Shanghai'"


def test_usage_timezone_invalid_value_falls_back_to_server_timezone():
    _, expr = _usage_timezone_expr("not/a-real-timezone")
    assert expr.startswith("INTERVAL '")


def test_usage_filters_default_to_platform_calls_and_can_include_byok_or_exclude_devs():
    assert len(_usage_filters(include_byok=False, exclude_dev=False)) == 1
    assert len(_usage_filters(include_byok=True, exclude_dev=False)) == 0
    assert len(_usage_filters(include_byok=False, exclude_dev=True)) == 2


def test_usage_local_hour_treats_naive_database_values_as_utc():
    from zoneinfo import ZoneInfo

    assert _usage_local_hour(datetime(2026, 9, 17, 12, 3), ZoneInfo("Asia/Shanghai")) == 20


def test_usage_boundaries_remain_aware_utc():
    from zoneinfo import ZoneInfo

    boundary = _utc_aware(datetime(2026, 9, 17, tzinfo=ZoneInfo("Asia/Shanghai")))
    assert boundary == datetime(2026, 9, 16, 16, tzinfo=timezone.utc)
