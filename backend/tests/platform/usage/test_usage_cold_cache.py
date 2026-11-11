"""场景统计区分低命中请求，非冷缓存率按输入 token 加权。"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.api.v1.agent_admin import _scenario_usage, _usage_filters
from app.models import AgentUsage
from agent.usage import record_usage


@pytest.mark.asyncio
async def test_scenario_cache_rate_excludes_reads_below_one_percent_and_keeps_weighting(db, user_a):
    start = datetime(2026, 10, 18, tzinfo=timezone.utc)
    for fresh, cached, written in [(1000, 0, 0), (100, 0, 50), (1000, 9000, 0),
                                   (99, 1, 0), (15872, 128, 0)]:
        db.add(AgentUsage(user_id=user_a.id, model="synthetic-model", provider="minimax",
                          scenario="reflection", tokens_in=fresh, cache_read=cached,
                          cache_write=written, created_at=start))
    # 无输入的工具计数不属于冷 LLM 请求。
    db.add(AgentUsage(user_id=user_a.id, model="synthetic-model", provider="minimax",
                      scenario="mcp", tokens_in=0, cache_read=0, created_at=start))
    await db.flush()
    rows = {row["scenario"]: row for row in await _scenario_usage(db, start, start + timedelta(days=1), [])}
    reflection = rows["reflection"]
    assert reflection["calls"] == 5
    assert reflection["cold_calls"] == 3
    assert reflection["tokens_in"] == 27250
    assert reflection["warm_tokens_in"] == 10100
    assert reflection["cache_ratio"] == round(9129 / 27250, 6)
    assert reflection["warm_cache_ratio"] == round(9001 / 10100, 6)
    assert rows["mcp"]["cold_calls"] == 0
    assert rows["mcp"]["warm_cache_ratio"] is None


@pytest.mark.asyncio
async def test_cold_tool_round_is_excluded_even_when_run_is_warm(db, user_a):
    settings = SimpleNamespace(quota=SimpleNamespace(default_token_limit_6h=None))
    model = SimpleNamespace(provider="minimax", model="synthetic-model", is_byok=True)
    start = datetime.now(timezone.utc) - timedelta(minutes=1)
    await record_usage(
        user_a.id, settings, model, db=db, tokens_in=16872, cache_read=9128,
        provider_rounds=[
            {"input": 15872, "cache_read": 128},
            {"input": 1000, "cache_read": 9000},
            {"output": 10},
        ],
    )
    await db.flush()
    row, = await _scenario_usage(db, start, start + timedelta(days=1), [])
    assert row["calls"] == 1
    assert row["cold_calls"] == 1
    assert row["tokens_in"] == 26000
    assert row["warm_tokens_in"] == 10000
    assert row["warm_cache_ratio"] == 0.9


@pytest.mark.asyncio
async def test_cold_cache_statistics_follow_period_byok_and_developer_filters(db, user_a, user_b):
    user_b.is_developer = True
    start = datetime(2026, 10, 18, tzinfo=timezone.utc)
    for user, byok, at in [(user_a, False, start), (user_a, True, start),
                           (user_b, False, start), (user_a, False, start - timedelta(seconds=1)),
                           (user_a, False, start + timedelta(days=1))]:
        db.add(AgentUsage(user_id=user.id, model="synthetic-model", provider="minimax",
                          scenario="reflection", tokens_in=100, cache_read=0, is_byok=byok,
                          created_at=at))
    await db.flush()
    rows = await _scenario_usage(db, start, start + timedelta(days=1),
                                 _usage_filters(include_byok=False, exclude_dev=True))
    assert len(rows) == 1
    assert rows[0]["calls"] == rows[0]["cold_calls"] == 1
    assert rows[0]["warm_tokens_in"] == 0
    assert rows[0]["warm_cache_ratio"] is None


@pytest.mark.asyncio
async def test_empty_cache_statistics_do_not_invent_requests(db):
    start = datetime(2026, 10, 18, tzinfo=timezone.utc)
    assert await _scenario_usage(db, start, start + timedelta(days=1), []) == []


@pytest.mark.asyncio
async def test_warm_ratio_preserves_legacy_full_input_convention(db, user_a):
    start = datetime(2026, 8, 1, tzinfo=timezone.utc)
    db.add(AgentUsage(user_id=user_a.id, model="synthetic-model", provider="openai",
                      scenario="reflection", tokens_in=1000, cache_read=800, created_at=start))
    await db.flush()
    row, = await _scenario_usage(db, start, start + timedelta(days=1), [])
    assert row["warm_tokens_in"] == 1000
    assert row["cold_calls"] == 0
    assert row["warm_cache_ratio"] == 0.8
