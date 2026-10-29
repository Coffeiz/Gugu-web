"""scored 群聊预算按作用域原子预留、幂等重试并支持确定失败退款。"""
import asyncio
from hashlib import sha256

import fakeredis.aioredis
import pytest

from agent.im.auto_reply.budget import (
    get_soft_anchor,
    recent_proactive_acceptances,
    register_soft_anchor,
    release_proactive_slot,
    reserve_proactive_slot,
    reserve_soft_slot,
    settle_proactive_slot,
    settle_soft_slot,
)


@pytest.mark.asyncio
async def test_attention_budget_is_idempotent_atomic_and_scoped():
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    async def reserve(run_id, at, *, group="group-a", mode="active"):
        return await reserve_proactive_slot(
            redis, platform="qq", bot_id="bot-a", group_id=group,
            run_id=run_id, mode=mode, now_ms=at,
        )

    duplicate = await asyncio.gather(*(reserve("same-run", 1_000_000) for _ in range(6)))
    assert all(duplicate)

    results = await asyncio.gather(*(
        reserve(f"run-{index}", 1_060_000 + index * 60_000)
        for index in range(8)
    ))
    assert sum(results) == 4  # 首次占用后，活动模式最多再占四个槽位

    assert await reserve("other-group", 1_060_000, group="group-b") is True
    assert await reserve("rollback-clock", 900_000) is False

    await release_proactive_slot(
        redis, platform="qq", bot_id="bot-a", group_id="group-a", run_id="same-run",
    )
    assert await reserve("replacement", 1_360_000) is True
    await redis.aclose()


@pytest.mark.asyncio
async def test_natural_budget_limit_and_minimum_gap():
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    common = dict(redis=redis, platform="telegram", bot_id="bot-a", group_id="group-a", mode="natural")
    assert await reserve_proactive_slot(**common, run_id="a", now_ms=2_000_000)
    await settle_proactive_slot(redis, platform="telegram", bot_id="bot-a", group_id="group-a", run_id="a", outcome="ACCEPTED", now_ms=2_000_000)
    assert not await reserve_proactive_slot(**common, run_id="b", now_ms=2_179_999)
    assert await reserve_proactive_slot(**common, run_id="b", now_ms=2_180_000)
    await settle_proactive_slot(redis, platform="telegram", bot_id="bot-a", group_id="group-a", run_id="b", outcome="ACCEPTED", now_ms=2_180_000)
    assert not await reserve_proactive_slot(**common, run_id="c", now_ms=2_360_000)
    assert await reserve_proactive_slot(**common, run_id="c", now_ms=2_600_000)
    await redis.aclose()


@pytest.mark.asyncio
async def test_proactive_reservation_tracks_accepted_and_unknown_states_with_bounded_ttl():
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    args = dict(platform="qq", bot_id="bot-a", group_id="group-a", run_id="run-a")
    assert await reserve_proactive_slot(redis, **args, mode="natural", now_ms=3_000_000)
    assert await settle_proactive_slot(redis, **args, outcome="UNKNOWN", now_ms=3_000_010)
    key = f"im:attention:budget:{{{sha256(b'qq\0bot-a\0group-a').hexdigest()}}}:state"
    assert await redis.hget(key, "run-a") == "UNKNOWN"
    assert await redis.zscore(key.replace(":state", ""), "run-a") is not None

    assert await settle_proactive_slot(redis, **args, outcome="ACCEPTED", now_ms=3_000_100)
    assert await redis.hget(key, "run-a") == "RECONCILED_ACCEPTED"
    assert await redis.zscore(key.replace(":state", ""), "run-a") == 3_000_100
    assert await recent_proactive_acceptances(
        redis, platform="qq", bot_id="bot-a", group_id="group-a",
        since_ms=3_000_000, until_ms=3_000_200,
    ) == (("run-a", 3_000_100),)
    await redis.aclose()


@pytest.mark.asyncio
async def test_soft_anchor_is_scoped_single_use_and_soft_budget_is_atomic():
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    common = dict(platform="telegram", bot_id="bot-a", group_id="group-a", sender_id="member-a")
    assert await register_soft_anchor(redis, **common, anchor_id="request-1")
    assert await get_soft_anchor(redis, **common) == "request-1"

    reservation = dict(**common, run_id="material-run", anchor_id="request-1")
    assert await reserve_soft_slot(redis, **reservation, now_ms=4_000_000)
    assert await get_soft_anchor(redis, **common) is None
    # 同一事件重投幂等；不同 run 不能重复消费同一索取锚点。
    assert await reserve_soft_slot(redis, **reservation, now_ms=4_000_001)
    assert not await reserve_soft_slot(
        redis, **{**reservation, "run_id": "duplicate-run"}, now_ms=4_000_002,
    )
    assert await settle_soft_slot(
        redis, **common, run_id="material-run", outcome="FAILED_CONFIRMED", now_ms=4_000_003,
    )
    await redis.aclose()


@pytest.mark.asyncio
async def test_soft_budget_limits_group_to_three_per_ten_minutes_and_sender_gap():
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    base = dict(platform="qq", bot_id="bot-a", group_id="group-a")
    for index, sender in enumerate(("a", "b", "c")):
        assert await register_soft_anchor(redis, **base, sender_id=sender, anchor_id=f"anchor-{index}")
        assert await reserve_soft_slot(
            redis, **base, sender_id=sender, run_id=f"run-{index}",
            anchor_id=f"anchor-{index}", now_ms=5_000_000 + index * 60_000,
        )
    assert await register_soft_anchor(redis, **base, sender_id="d", anchor_id="anchor-d")
    assert not await reserve_soft_slot(
        redis, **base, sender_id="d", run_id="run-d", anchor_id="anchor-d",
        now_ms=5_180_000,
    )
    await redis.aclose()
