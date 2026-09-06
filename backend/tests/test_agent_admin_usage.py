from datetime import datetime, timezone

from app.api.v1.agent_admin import (
    _CACHE_USAGE_CUTOFF_SQL,
    _effective_input_sql,
    _effective_input_tokens,
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
